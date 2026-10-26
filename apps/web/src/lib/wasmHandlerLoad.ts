import type { DiffChange } from "../types";
import type { GoConstructor } from "./wasm_exec";
import { HandlerError, instantiateFhr1, isFhr1 } from "./fhrWasm1";

// The pure wasm-instantiation logic shared by both places it can run: directly
// (tests, and previously the main thread) and inside browserWasmWorker.ts
// (issue #177 — the worker port). Nothing here knows about Worker/postMessage.
// Two kinds of build arrive from the /handlers proxy, told apart by their
// exports, exactly as the API's wasm-worker.cjs tells them apart server-side:
// an fhr-wasm-1 module (FHR SPEC §7, any language; fhrWasm1.ts hosts it) and a
// Go GOOS=js build, whose `__forgeHandler*` global is discovered below. Both
// come out as the same BrowserWasmHandler.

/** The structured diff a wasm handler produces — same wire shape the server returns. */
export type BrowserStructuredDiff = { version: string; format: string; changes: DiffChange[] };

/** What a handler's optional preview call answers (FHR SPEC §7). */
export type WasmPreviewResult = { mediaType?: string; blob?: Uint8Array; error?: string };

/**
 * The callable a loaded wasm build registers: bytes in, raw JSON string out —
 * plus, on handlers that declare one, `preview`, which answers an object so a
 * large preview never round-trips through base64.
 */
export type BrowserWasmHandler = {
  diff(base: Uint8Array, head: Uint8Array): string;
  info?(): string;
  preview?(blob: Uint8Array): WasmPreviewResult;
};

/** The handler's preview media type, or null when it has no preview call. */
export function previewTypeOf(handler: BrowserWasmHandler): string | null {
  if (typeof handler.preview !== "function") return null;
  try {
    return (JSON.parse(handler.info?.() ?? "{}") as { preview?: string }).preview ?? null;
  } catch {
    return null;
  }
}

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

// Instantiate a GOOS=js handler build — mirrors the API's wasm-worker.cjs:
// snapshot the __forgeHandler* globals, run the program (it registers its api
// synchronously, then parks on select{}), and pick up the global it added.
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

/**
 * Instantiate whichever kind of build `bytes` holds: an fhr-wasm-1 module (FHR
 * SPEC §7) or a Go GOOS=js build. Either way the caller gets the same
 * BrowserWasmHandler: JSON-string answers, {"error": …} for a refusal.
 */
export async function instantiateHandler(
  bytes: ArrayBuffer,
  handlerId: string,
  deps: PageInstantiateDeps = pageDeps,
): Promise<BrowserWasmHandler> {
  const module = await WebAssembly.compile(bytes);
  if (!isFhr1(module)) return instantiateOnPage(bytes, handlerId, deps);
  const call = await instantiateFhr1(module, (line) => console.warn(`[wasm ${handlerId}] ${line}`));
  const json = (fn: () => unknown): string => {
    try {
      return JSON.stringify(fn());
    } catch (e) {
      if (e instanceof HandlerError) return JSON.stringify({ error: e.message });
      throw e;
    }
  };
  const handler: BrowserWasmHandler = {
    diff: (base, head) => json(() => call("diff", [base, head]).result),
    info: () => json(() => call("info").result),
  };
  // Only a handler that declares a preview gets the call, as a Go build registers it.
  if ((JSON.parse(handler.info!()) as { preview?: string }).preview) {
    handler.preview = (blob) => {
      try {
        const { result, blobs } = call("preview", [blob]);
        return { mediaType: (result as { mediaType?: string } | undefined)?.mediaType, blob: blobs[0] };
      } catch (e) {
        if (e instanceof HandlerError) return { error: e.message };
        throw e;
      }
    };
  }
  return handler;
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
