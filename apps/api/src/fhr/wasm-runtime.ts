import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { StructuredDiff } from "../handlers/types.js";

/** One unresolved conflict a handler's merge reports, at a diff path. */
export type WasmConflict = { path: string; ours: unknown; theirs: unknown };

export type WasmMergeResult = { blob: Buffer; conflicts: WasmConflict[] };

export type WasmPreview = { bytes: Uint8Array; mediaType: string };

/** A GLB a handler imported from its own format (FHR SPEC §7 `import`). */
export type WasmImport = { bytes: Uint8Array };

export type WasmHandler = {
  diff(base: Buffer, head: Buffer): Promise<StructuredDiff>;
  /**
   * The media type of the handler's optional `preview` call (FHR SPEC §7);
   * null or absent when it has none — a format the browser draws from its own
   * bytes. Known once the worker is ready.
   */
  readonly previewType?: string | null;
  /** Convert one blob for display. Rejects when there is no previewType. */
  preview?(blob: Buffer): Promise<WasmPreview>;
  /**
   * Whether the handler declares a semantic merge (its `info` capabilities).
   * Absent or false: merge must not be asked for. Known once the worker is
   * ready, which instantiateWasmHandler awaits.
   */
  readonly semanticMerge?: boolean;
  /**
   * Three-way merge. The blob holds ours wherever the handler could not
   * reconcile, and `conflicts` says where; empty conflicts is a clean merge.
   */
  merge?(base: Buffer, ours: Buffer, theirs: Buffer): Promise<WasmMergeResult>;
  /**
   * Transcoding through glTF (FHR SPEC §7 `import` / `export`): a handler that
   * can read its format into a GLB, and one that can write a GLB out as its
   * format. Both false or absent for a handler that does neither. `formats`
   * is the extensions the handler owns — the targets `export` accepts.
   */
  readonly canImport?: boolean;
  readonly canExport?: boolean;
  readonly formats?: readonly string[];
  /** The handler's own format → a GLB, faithfully. Rejects unless canImport. */
  import?(blob: Buffer): Promise<WasmImport>;
  /** A GLB → one of `formats`. Rejects unless canExport. */
  export?(glb: Buffer, format: string): Promise<Uint8Array>;
};

/** Parse a wasm handler's JSON merge output. */
function parseMergeOutput(raw: string, handlerId: string): WasmMergeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`wasm ${handlerId}: unparseable merge output`);
  }
  const obj = parsed as { error?: string; blob?: string; conflicts?: WasmConflict[] };
  if (obj.error) throw new Error(`wasm ${handlerId}: ${obj.error}`);
  if (typeof obj.blob !== "string") throw new Error(`wasm ${handlerId}: merge returned no blob`);
  return { blob: Buffer.from(obj.blob, "base64"), conflicts: obj.conflicts ?? [] };
}

const DEFAULT_WORKER = fileURLToPath(new URL("./wasm-worker.cjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = Number(process.env["FHR_WASM_TIMEOUT_MS"] ?? 5000);

type WorkerResult = { raw?: string; bytes?: Uint8Array; mediaType?: string };
type Pending = { resolve: (r: WorkerResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

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
  semanticMerge = false;
  previewType: string | null = null;
  canImport = false;
  canExport = false;
  formats: readonly string[] = [];

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

      worker.on("message", (msg: {
        type: string;
        id?: number;
        raw?: string;
        bytes?: Uint8Array;
        mediaType?: string;
        error?: string;
        semanticMerge?: boolean;
        previewType?: string | null;
        canImport?: boolean;
        canExport?: boolean;
        formats?: string[];
      }) => {
        if (msg.type === "ready") {
          ready = true;
          this.semanticMerge = msg.semanticMerge === true;
          this.previewType = msg.previewType ?? null;
          this.canImport = msg.canImport === true;
          this.canExport = msg.canExport === true;
          this.formats = msg.formats ?? [];
          resolveReady();
        } else if (msg.type === "init-error") {
          rejectReady(new Error(`wasm ${this.handlerId} init: ${msg.error}`));
        } else if (msg.type === "result" && msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`wasm ${this.handlerId}: ${msg.error}`));
          else p.resolve({ raw: msg.raw, bytes: msg.bytes, mediaType: msg.mediaType });
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

  /** One bounded call into the worker; a call that overruns kills the worker. */
  private async call(what: "diff" | "merge" | "preview" | "import" | "export", payload: Record<string, Buffer | string>): Promise<WorkerResult> {
    await this.ensure();
    const worker = this.worker;
    if (!worker) throw new Error(`wasm ${this.handlerId}: worker unavailable`);

    return new Promise<WorkerResult>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Hung call: kill the worker so it can't wedge future calls; next call respawns.
        const err = new Error(`wasm ${this.handlerId}: ${what} timed out after ${this.timeoutMs}ms`);
        this.fail(err);
        reject(err);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: what, id, ...payload });
    });
  }

  async diff(base: Buffer, head: Buffer): Promise<StructuredDiff> {
    return parseDiffOutput((await this.call("diff", { base, head })).raw ?? "", this.handlerId);
  }

  async merge(base: Buffer, ours: Buffer, theirs: Buffer): Promise<WasmMergeResult> {
    if (!this.semanticMerge) throw new Error(`wasm ${this.handlerId}: handler declares no semantic merge`);
    return parseMergeOutput((await this.call("merge", { base, ours, theirs })).raw ?? "", this.handlerId);
  }

  async preview(blob: Buffer): Promise<WasmPreview> {
    if (!this.previewType) throw new Error(`wasm ${this.handlerId}: handler has no preview`);
    const { bytes, mediaType } = await this.call("preview", { blob });
    if (!bytes) throw new Error(`wasm ${this.handlerId}: preview returned no bytes`);
    return { bytes, mediaType: mediaType ?? this.previewType };
  }

  async import(blob: Buffer): Promise<WasmImport> {
    if (!this.canImport) throw new Error(`wasm ${this.handlerId}: handler cannot import`);
    const { bytes } = await this.call("import", { blob });
    if (!bytes) throw new Error(`wasm ${this.handlerId}: import returned no bytes`);
    return { bytes };
  }

  async export(glb: Buffer, format: string): Promise<Uint8Array> {
    if (!this.canExport) throw new Error(`wasm ${this.handlerId}: handler cannot export`);
    const { bytes } = await this.call("export", { blob: glb, format });
    if (!bytes) throw new Error(`wasm ${this.handlerId}: export returned no bytes`);
    return bytes;
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
