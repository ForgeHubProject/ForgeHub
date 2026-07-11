import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { StructuredDiff } from "../handlers/types.js";

export type WasmHandler = {
  diff(base: Buffer, head: Buffer): Promise<StructuredDiff>;
};

const DEFAULT_WORKER = fileURLToPath(new URL("./wasm-worker.cjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = Number(process.env["FHR_WASM_TIMEOUT_MS"] ?? 5000);

type Pending = { resolve: (raw: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Parse a wasm handler's JSON diff output into a StructuredDiff. */
function parseDiffOutput(raw: string, handlerId: string): StructuredDiff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`wasm ${handlerId}: unparseable diff output`);
  }
  const obj = parsed as { error?: string; format?: string; changes?: StructuredDiff["changes"] };
  if (obj.error) throw new Error(`wasm ${handlerId}: ${obj.error}`);
  return { version: "1.0", format: obj.format ?? handlerId, changes: obj.changes ?? [] };
}

/**
 * Runs an official FHR wasm handler in a Worker thread. Each diff() is bounded
 * by a timeout; a call that overruns terminates the worker (a synchronous wasm
 * call cannot be interrupted otherwise) and rejects, and the next call
 * transparently respawns the worker. Instances are reused across calls.
 */
class WasmWorkerHandler implements WasmHandler {
  private worker: Worker | null = null;
  private readyP: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(
    private readonly bytes: Buffer,
    private readonly handlerId: string,
    private readonly workerPath: string,
    private readonly timeoutMs: number,
  ) {}

  private spawn(): Promise<void> {
    return new Promise<void>((resolveReady, rejectReady) => {
      const worker = new Worker(this.workerPath, { workerData: { bytes: this.bytes, handlerId: this.handlerId } });
      this.worker = worker;
      let ready = false;

      worker.on("message", (msg: { type: string; id?: number; raw?: string; error?: string }) => {
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
      });
      worker.on("error", (err) => {
        if (!ready) rejectReady(err);
        // Only act if this is still the live worker — a terminated worker's late
        // error/exit must not tear down a freshly respawned replacement.
        if (this.worker === worker) this.fail(err);
      });
      worker.on("exit", (code) => {
        if (code !== 0 && this.worker === worker) {
          this.fail(new Error(`wasm ${this.handlerId}: worker exited with code ${code}`));
        }
      });
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
      void this.worker.terminate();
      this.worker = null;
    }
    this.readyP = null;
  }

  private ensure(): Promise<void> {
    if (!this.readyP) this.readyP = this.spawn();
    return this.readyP;
  }

  async diff(base: Buffer, head: Buffer): Promise<StructuredDiff> {
    await this.ensure();
    const worker = this.worker;
    if (!worker) throw new Error(`wasm ${this.handlerId}: worker unavailable`);

    const raw = await new Promise<string>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Hung call: kill the worker so it can't wedge future calls; next diff respawns.
        this.fail(new Error(`wasm ${this.handlerId}: diff timed out after ${this.timeoutMs}ms`));
        reject(new Error(`wasm ${this.handlerId}: diff timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "diff", id, base, head });
    });
    return parseDiffOutput(raw, this.handlerId);
  }
}

export type InstantiateOptions = { workerPath?: string; timeoutMs?: number };

/**
 * Instantiate an official FHR handler's WebAssembly build in a Worker and
 * return a typed diff() wrapper. Rejects if the wasm fails to initialize, so
 * the caller can fall back to the built-in TS handler.
 *
 * Security: only *official* handlers reach here (see official-handlers.ts);
 * community handlers are never fetched or executed server-side. The wasm runs
 * with wasm_exec's built-in minimal fs stub (no Node fs/child_process), inside
 * an isolated worker, under a per-call timeout.
 */
export async function instantiateWasmHandler(
  bytes: Buffer,
  handlerId: string,
  opts: InstantiateOptions = {},
): Promise<WasmHandler> {
  const handler = new WasmWorkerHandler(
    bytes,
    handlerId,
    opts.workerPath ?? DEFAULT_WORKER,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  // Surface init failures now (spawn + wait for "ready") so official-handlers
  // can cache null and fall back rather than failing on first diff.
  await (handler as unknown as { ensure(): Promise<void> }).ensure();
  return handler;
}
