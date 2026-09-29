import { instantiateOnPage, previewTypeOf, type BrowserWasmHandler } from "./wasmHandlerLoad";

// Dedicated Web Worker entry point (issue #177): runs the official handler's
// wasm build off the page's main thread, so a pathological input hangs only
// this worker — which browserWasm.ts kills on timeout — instead of freezing
// the tab. Mirrors the API's wasm-worker.cjs, one thread flavor over (Worker
// vs. node:worker_threads). Bundled as its own chunk by Vite's
// `new Worker(new URL(...))` convention; loaded only when Tier B actually runs.
//
// Wire contract with browserWasm.ts (WorkerWasmHandler):
//   → {type: "init", bytes, handlerId}
//   ← {type: "ready", previewType} | {type: "init-error", error}
//   → {type: "diff", id, base, head}
//   ← {type: "result", id, raw} | {type: "result", id, error}
//   → {type: "preview", id, blob}           (FHR SPEC §7, when previewType)
//   ← {type: "result", id, bytes, mediaType} | {type: "result", id, error}
//
// Parsing the raw JSON stays on the main thread (parseDiffOutput in
// wasmHandlerLoad.ts) — this worker only moves bytes, same split as the
// server's worker/runtime pair.

type InitMsg = { type: "init"; bytes: ArrayBuffer; handlerId: string };
type DiffMsg = { type: "diff"; id: number; base: Uint8Array; head: Uint8Array };
type PreviewMsg = { type: "preview"; id: number; blob: Uint8Array };

let handlerP: Promise<BrowserWasmHandler> | null = null;

self.onmessage = (ev: MessageEvent<InitMsg | DiffMsg | PreviewMsg>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    handlerP = instantiateOnPage(msg.bytes, msg.handlerId);
    handlerP.then(
      (handler) => postMessage({ type: "ready", previewType: previewTypeOf(handler) }),
      (e: unknown) => postMessage({ type: "init-error", error: String((e as Error)?.message ?? e) }),
    );
    return;
  }
  if (msg.type === "diff") {
    void (async () => {
      try {
        const handler = await handlerP;
        if (!handler) throw new Error("handler not initialized");
        const raw = handler.diff(msg.base, msg.head);
        postMessage({ type: "result", id: msg.id, raw });
      } catch (e) {
        postMessage({ type: "result", id: msg.id, error: String((e as Error)?.message ?? e) });
      }
    })();
  }
  if (msg.type === "preview") {
    void (async () => {
      try {
        const handler = await handlerP;
        if (!handler?.preview) throw new Error("handler has no preview");
        const out = handler.preview(msg.blob);
        if (out.error || !out.blob) throw new Error(out.error ?? "preview returned no bytes");
        // Transfer, not copy: a preview can be as large as the model.
        (postMessage as (m: unknown, t: Transferable[]) => void)(
          { type: "result", id: msg.id, bytes: out.blob, mediaType: out.mediaType },
          [out.blob.buffer],
        );
      } catch (e) {
        postMessage({ type: "result", id: msg.id, error: String((e as Error)?.message ?? e) });
      }
    })();
  }
};
