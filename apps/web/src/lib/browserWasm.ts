import { API_BASE } from "../api";
import type { DiffChange } from "../types";
import type { GoConstructor } from "./wasm_exec";

// Tier-B compute: run the official FHR handler's wasm build IN THE BROWSER
// (issue #66 P4, SPEC-RENDERING §4). This is the client twin of the API's
// official-handlers.ts/wasm-runtime.ts pair: the same GOOS=js binary, fetched
// through the API's /handlers proxy (same-origin, so the manifest's host needn't
// serve CORS), instantiated with the same vendored Go wasm_exec runtime,
// exposing the same `diff(base, head) → JSON string` global the server worker
// calls.
//
// Trust model: only *official* builds are reachable — the proxy resolves
// exclusively through the FHR manifest, so this path can never load a
// community handler. Running it here is a cost/perf choice, not a trust one
// (SPEC-RENDERING P6); community compute belongs to the consented sandbox
// (#70), not this module.
//
// The wasm runs on the MAIN THREAD, and that is the weak point of this module,
// not a settled one: `handler.diff()` is a synchronous call with no timeout and
// no abort path, so a pathological input freezes the viewer's tab outright. The
// only thing standing between a user and that is capability detection
// (computeTier.ts TIER_B_MAX_BLOB_BYTES), which is why that ceiling is pinned to
// the server's own per-blob MAX_WASM_BYTES rather than anything larger — the
// server refuses to attempt more than that even with a worker it can kill, so
// offering the browser more would be backwards. Raising it is a worker port,
// not a constant change.

/** The structured diff a wasm handler produces — same wire shape the server returns. */
export type BrowserStructuredDiff = { version: string; format: string; changes: DiffChange[] };

/** The callable a loaded wasm build registers: bytes in, raw JSON string out. */
export type BrowserWasmHandler = { diff(base: Uint8Array, head: Uint8Array): string };

export type BrowserWasmDeps = {
  fetchImpl: typeof fetch;
  instantiate: (bytes: ArrayBuffer, handlerId: string) => Promise<BrowserWasmHandler>;
};

const defaultDeps: BrowserWasmDeps = {
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  instantiate: instantiateOnPage,
};

/**
 * The two ambient things instantiation reaches for, injectable so the
 * global-discovery logic below is testable without a real Go build.
 */
export type PageInstantiateDeps = {
  /** Installs `globalThis.Go` (the vendored wasm_exec runtime). */
  loadGoRuntime: () => Promise<void>;
  instantiateWasm: (
    bytes: ArrayBuffer,
    imports: WebAssembly.Imports,
  ) => Promise<{ instance: WebAssembly.Instance }>;
  scope: Record<string, unknown>;
};

const pageDeps: PageInstantiateDeps = {
  loadGoRuntime: async () => {
    await import("./wasm_exec.js"); // side effect: installs globalThis.Go
  },
  instantiateWasm: (bytes, imports) => WebAssembly.instantiate(bytes, imports),
  scope: globalThis as unknown as Record<string, unknown>,
};

// Instantiate a GOOS=js handler build on this page — mirrors the API's
// wasm-worker.cjs: snapshot the __forgeHandler* globals, run the program (it
// registers its api synchronously, then parks on select{}), and pick up the
// global it added.
export async function instantiateOnPage(
  bytes: ArrayBuffer,
  handlerId: string,
  deps: PageInstantiateDeps = pageDeps,
): Promise<BrowserWasmHandler> {
  await deps.loadGoRuntime();
  const g = deps.scope;
  const Go = g["Go"] as GoConstructor | undefined;
  if (!Go) throw new Error(`wasm ${handlerId}: Go runtime failed to load`);

  const handlerGlobals = () => Object.keys(g).filter((k) => k.startsWith("__forgeHandler"));
  const before = new Set(handlerGlobals());

  const go = new Go();
  const { instance } = await deps.instantiateWasm(bytes, go.importObject);
  void go.run(instance);

  const key = handlerGlobals().find((k) => {
    const api = g[k] as { diff?: unknown } | undefined;
    return !before.has(k) && typeof api?.diff === "function";
  });
  if (!key) throw new Error(`wasm ${handlerId}: registered no diff() global`);
  return g[key] as BrowserWasmHandler;
}

/** Parse a wasm handler's JSON diff output — same contract as the server runtime. */
export function parseDiffOutput(raw: string, handlerId: string): BrowserStructuredDiff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`wasm ${handlerId}: unparseable diff output`);
  }
  const obj = parsed as { error?: string; format?: string; changes?: DiffChange[] };
  if (obj.error) throw new Error(`wasm ${handlerId}: ${obj.error}`);
  return { version: "1.0", format: obj.format ?? handlerId, changes: obj.changes ?? [] };
}

// One in-flight/loaded instance per handler — the build is a singleton module.
const cache = new Map<string, Promise<BrowserWasmHandler>>();

/** Test hook: drop memoized handler instances. */
export function __resetBrowserHandlers(): void {
  cache.clear();
}

/**
 * Fetch a handler's official wasm build through the API proxy and instantiate
 * it, memoized per handler so repeated diffs reuse one instance. A failed load
 * is not memoized, allowing a retry after a transient error.
 */
export function loadBrowserHandler(handlerId: string, deps: BrowserWasmDeps = defaultDeps): Promise<BrowserWasmHandler> {
  let p = cache.get(handlerId);
  if (!p) {
    p = (async () => {
      const res = await deps.fetchImpl(`${API_BASE}/handlers/${encodeURIComponent(handlerId)}`);
      if (!res.ok) throw new Error(`wasm build for '${handlerId}' unavailable (HTTP ${res.status})`);
      return deps.instantiate(await res.arrayBuffer(), handlerId);
    })();
    p.catch(() => cache.delete(handlerId));
    cache.set(handlerId, p);
  }
  return p;
}

/**
 * Compute a structured diff for a blob pair in the browser. The caller has
 * already downloaded both blobs (after the honest cost disclosure); this runs
 * the exact binary the server would run, so the result matches Tier S when the
 * builds match — computeTier.buildMismatch() is how skew gets surfaced.
 */
export async function browserWasmDiff(
  handlerId: string,
  base: Uint8Array,
  head: Uint8Array,
  deps: BrowserWasmDeps = defaultDeps,
): Promise<BrowserStructuredDiff> {
  const handler = await loadBrowserHandler(handlerId, deps);
  return parseDiffOutput(handler.diff(base, head), handlerId);
}
