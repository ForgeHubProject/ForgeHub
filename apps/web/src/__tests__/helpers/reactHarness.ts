/**
 * A dependency-free harness for MOUNTING a React function component and
 * observing what it does — specifically, which requests its effects fire.
 *
 * Why this exists: `apps/web`'s vitest runs in the `node` environment with no
 * DOM and no react-dom/testing-library, so component behaviour has been
 * untestable here. That is exactly why the "don't fetch metadata for rows
 * nobody touched" fix could be reverted with the suite staying green: the
 * rendered OUTPUT is identical either way, only the CALL PATTERN differs, and
 * nothing was watching it.
 *
 * How it works: the test file mocks the four hooks the components under test
 * use (`useState`, `useEffect`, `useCallback`, `useMemo`, `useRef`) with the
 * implementations below and keeps the rest of React real. `mount()` then calls
 * the component function directly, runs its effects, lets promises settle, and
 * re-renders while state keeps changing — the mount-and-settle sequence a real
 * render would produce. Child elements are NOT rendered (React elements are
 * inert descriptions), which is what keeps this small: only the component under
 * test executes hooks. Any hook we do NOT implement falls through to the real
 * React one and throws loudly rather than passing silently.
 *
 * This is a scalpel, not a renderer: it is for asserting effect/call behaviour,
 * not markup.
 */

type StateSlot = { kind: "state"; value: unknown; setter: (v: unknown) => void };
type RefSlot = { kind: "ref"; ref: { current: unknown } };
type MemoSlot = { kind: "memo"; deps: unknown[] | undefined; value: unknown };
type EffectSlot = {
  kind: "effect";
  ran: boolean;
  deps: unknown[] | undefined;
  cleanup: (() => void) | void;
};
type Slot = StateSlot | RefSlot | MemoSlot | EffectSlot;

type PendingEffect = { index: number; fn: () => unknown; deps: unknown[] | undefined };

type Instance<P> = {
  Component: (props: P) => unknown;
  props: P;
  slots: Slot[];
  cursor: number;
  pending: PendingEffect[];
  dirty: boolean;
  element: unknown;
};

let current: Instance<never> | null = null;

function inst(): Instance<never> {
  if (!current) throw new Error("harness hook called outside a harness render");
  return current;
}

function depsChanged(next: unknown[] | undefined, prev: unknown[] | undefined): boolean {
  if (next === undefined || prev === undefined) return true;
  if (next.length !== prev.length) return true;
  return next.some((d, i) => !Object.is(d, prev[i]));
}

function useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
  const self = inst();
  const i = self.cursor++;
  if (!self.slots[i]) {
    const slot: StateSlot = {
      kind: "state",
      value: typeof initial === "function" ? (initial as () => S)() : initial,
      setter: () => {},
    };
    slot.setter = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(slot.value) : v;
      if (Object.is(next, slot.value)) return;
      slot.value = next;
      self.dirty = true;
    };
    self.slots[i] = slot;
  }
  const slot = self.slots[i] as StateSlot;
  return [slot.value as S, slot.setter as (v: S | ((p: S) => S)) => void];
}

function useRef<T>(initial: T): { current: T } {
  const self = inst();
  const i = self.cursor++;
  if (!self.slots[i]) self.slots[i] = { kind: "ref", ref: { current: initial } };
  return (self.slots[i] as RefSlot).ref as { current: T };
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const self = inst();
  const i = self.cursor++;
  const prev = self.slots[i] as MemoSlot | undefined;
  if (!prev || depsChanged(deps, prev.deps)) {
    self.slots[i] = { kind: "memo", deps, value: factory() };
  }
  return (self.slots[i] as MemoSlot).value as T;
}

// Identity churn only costs memoization, which this harness does not assert on.
function useCallback<T>(fn: T, _deps?: unknown[]): T {
  return fn;
}

function useEffect(fn: () => unknown, deps?: unknown[]): void {
  const self = inst();
  const i = self.cursor++;
  if (!self.slots[i]) self.slots[i] = { kind: "effect", ran: false, deps: undefined, cleanup: undefined };
  self.pending.push({ index: i, fn, deps });
}

/** Spread over the real `react` module in a `vi.mock` factory. */
export const harnessHooks = {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect: useEffect,
};

export type Mounted<P> = {
  /** The element tree from the most recent render. */
  element: unknown;
  /** Re-render + flush effects until state stops changing. */
  settle: () => Promise<void>;
  /** Run pending cleanups, as an unmount would. */
  unmount: () => void;
  props: P;
};

function renderOnce<P>(self: Instance<P>): void {
  self.cursor = 0;
  self.pending = [];
  const prev = current;
  current = self as unknown as Instance<never>;
  try {
    self.element = self.Component(self.props);
  } finally {
    current = prev;
  }
}

function runEffects<P>(self: Instance<P>): void {
  for (const p of self.pending) {
    const slot = self.slots[p.index] as EffectSlot;
    if (slot.ran && !depsChanged(p.deps, slot.deps)) continue;
    if (slot.ran && typeof slot.cleanup === "function") slot.cleanup();
    const cleanup = p.fn();
    slot.cleanup = typeof cleanup === "function" ? (cleanup as () => void) : undefined;
    slot.deps = p.deps;
    slot.ran = true;
  }
}

/**
 * Mount `Component` with `props` and settle: render, run effects, let pending
 * promises resolve, and repeat while state keeps changing (bounded, so a
 * genuine render loop fails the test instead of hanging).
 */
export async function mount<P>(Component: (props: P) => unknown, props: P): Promise<Mounted<P>> {
  const self: Instance<P> = {
    Component,
    props,
    slots: [],
    cursor: 0,
    pending: [],
    dirty: false,
    element: null,
  };

  const settle = async () => {
    for (let pass = 0; pass < 25; pass++) {
      self.dirty = false;
      renderOnce(self);
      runEffects(self);
      // Two macrotask turns: enough for a chain of already-resolved promises
      // (fetch mock → .then → setState) to land before the next render.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      if (!self.dirty) return;
    }
    throw new Error("harness: component never settled (render loop?)");
  };

  await settle();

  return {
    get element() {
      return self.element;
    },
    settle,
    unmount: () => {
      for (const slot of self.slots) {
        if (slot && slot.kind === "effect" && typeof slot.cleanup === "function") slot.cleanup();
      }
    },
    props,
  };
}

type ElementLike = { type: unknown; props?: Record<string, unknown> };

function isElement(v: unknown): v is ElementLike {
  return typeof v === "object" && v !== null && "type" in v && "props" in v;
}

function walk(node: unknown, visit: (el: ElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isElement(node)) return;
  visit(node);
  const children = (node.props as { children?: unknown } | undefined)?.children;
  if (children !== undefined) walk(children, visit);
}

/** The first element in the tree whose type is `type`, or null. */
export function findByType(tree: unknown, type: unknown): ElementLike | null {
  let hit: ElementLike | null = null;
  walk(tree, (el) => {
    if (!hit && el.type === type) hit = el;
  });
  return hit;
}

/** Every string of rendered text in the tree, flattened. */
export function textOf(tree: unknown): string {
  const parts: string[] = [];
  const collect = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      parts.push(String(node));
      return;
    }
    if (isElement(node)) collect((node.props as { children?: unknown } | undefined)?.children);
  };
  collect(tree);
  return parts.join(" ");
}
