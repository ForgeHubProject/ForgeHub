import { API_BASE } from "../api";
import { parseDiffOutput, type BrowserStructuredDiff } from "./wasmHandlerLoad";

export type { BrowserStructuredDiff };

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
// The wasm runs in a dedicated Web Worker (issue #177 — closed: it used to run
// on the main thread, where a hang froze the tab). browserWasmWorker.ts is the
// worker entry point; this module spawns it, sends bytes over, and bounds each
// diff() call with a wall-clock timeout that terminates and respawns the
// worker on overrun — the same shape as the server's WasmWorkerHandler in
// fhr/wasm-runtime.ts, ported from node:worker_threads to the Worker API.

/** Per-call bound; a hang past this kills the worker and the next call respawns it. */
export const BROWSER_WASM_TIMEOUT_MS = 15_000;

/** The subset of the Worker surface used here, injectable for tests. */
export type WorkerLike = {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
};

export type BrowserWasmDeps = {
  fetchImpl: typeof fetch;
  createWorker: () => WorkerLike;
  timeoutMs: number;
};

function defaultCreateWorker(): WorkerLike {
  return new Worker(new URL("./browserWasmWorker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

const defaultDeps: BrowserWasmDeps = {
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  createWorker: defaultCreateWorker,
  timeoutMs: BROWSER_WASM_TIMEOUT_MS,
};

type Pending = { resolve: (raw: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Runs one handler's wasm build in a Worker. Each diff() is bounded by a
 * timeout; a call that overruns terminates the worker (a synchronous wasm call
 * can't be interrupted otherwise) and rejects, and the next call transparently
 * respawns it.
 */
export class WorkerWasmHandler {
  private worker: WorkerLike | null = null;
  private readyP: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(
    private readonly bytes: ArrayBuffer,
    private readonly handlerId: string,
    private readonly createWorker: () => WorkerLike,
    private readonly timeoutMs: number,
  ) {}

  private spawn(): Promise<void> {
    return new Promise<void>((resolveReady, rejectReady) => {
      const worker = this.createWorker();
      this.worker = worker;
      let ready = false;

      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type: string; id?: number; raw?: string; error?: string };
        if (msg.type === "ready") {
          ready = true;
          resolveReady();
        } else if (msg.type === "init-error") {
          rejectReady(new Error(`wasm ${this.handlerId} init: ${msg.error}`));
        } else if (msg.type === "result" && msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`wasm ${this.handlerId}: ${msg.error}`));
          else p.resolve(msg.raw ?? "");
        }
      };
      worker.onerror = (ev: ErrorEvent) => {
        const err = new Error(ev.message || `wasm ${this.handlerId}: worker error`);
        if (!ready) rejectReady(err);
        // Only act if this is still the live worker — a terminated worker's
        // late error must not tear down a freshly respawned replacement.
        if (this.worker === worker) this.fail(err);
      };
      worker.postMessage({ type: "init", bytes: this.bytes, handlerId: this.handlerId });
    });
  }

  /** Reject all in-flight calls and tear the worker down so the next call respawns. */
  private fail(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.readyP = null;
  }

  private ensure(): Promise<void> {
    if (!this.readyP) this.readyP = this.spawn();
    return this.readyP;
  }

  async diff(base: Uint8Array, head: Uint8Array): Promise<string> {
    await this.ensure();
    const worker = this.worker;
    if (!worker) throw new Error(`wasm ${this.handlerId}: worker unavailable`);

    return new Promise<string>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Hung call: kill the worker so it can't wedge future calls; next diff respawns.
        const err = new Error(`wasm ${this.handlerId}: diff timed out after ${this.timeoutMs}ms`);
        this.fail(err);
        reject(err);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "diff", id, base, head });
    });
  }
}

// One in-flight/loaded handler per wasm build — the build is a singleton module.
const cache = new Map<string, Promise<WorkerWasmHandler>>();

/** Test hook: drop memoized handler instances (and their workers). */
export function __resetBrowserHandlers(): void {
  for (const p of cache.values()) {
    p.then((h) => (h as unknown as { worker: WorkerLike | null }).worker?.terminate()).catch(() => {});
  }
  cache.clear();
}

/**
 * Fetch a handler's official wasm build through the API proxy and spawn its
 * worker, memoized per handler so repeated diffs reuse one instance. A failed
 * load is not memoized, allowing a retry after a transient error.
 */
export function loadBrowserHandler(handlerId: string, deps: BrowserWasmDeps = defaultDeps): Promise<WorkerWasmHandler> {
  let p = cache.get(handlerId);
  if (!p) {
    p = (async () => {
      const res = await deps.fetchImpl(`${API_BASE}/handlers/${encodeURIComponent(handlerId)}`);
      if (!res.ok) throw new Error(`wasm build for '${handlerId}' unavailable (HTTP ${res.status})`);
      const bytes = await res.arrayBuffer();
      const handler = new WorkerWasmHandler(bytes, handlerId, deps.createWorker, deps.timeoutMs);
      // Surface init failures now (spawn + wait for "ready") so a bad build
      // fails the load rather than the first diff.
      await (handler as unknown as { ensure(): Promise<void> }).ensure();
      return handler;
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
  const raw = await handler.diff(base, head);
  return parseDiffOutput(raw, handlerId);
}
