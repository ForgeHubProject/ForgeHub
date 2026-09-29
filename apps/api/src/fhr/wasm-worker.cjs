"use strict";
// Worker that runs one official FHR wasm handler, isolated from the API's main
// event loop (SPEC-RENDERING §7d hardening). A synchronous wasm call can't be
// interrupted from JS, so it runs here where a hang blocks only this worker —
// which the main thread terminates on timeout. Plain CJS so it runs directly
// under both tsx (dev) and node (prod) with no TypeScript loader in the worker.
const { parentPort, workerData } = require("node:worker_threads");
require("./wasm_exec.cjs"); // sets this worker's globalThis.Go (+ fs/process stubs)

function handlerGlobals() {
  return Object.keys(globalThis).filter((k) => k.startsWith("__forgeHandler"));
}

(async () => {
  try {
    const { bytes } = workerData;
    const before = new Set(handlerGlobals());
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(instance); // registers the api synchronously, then parks on select{}

    const key = handlerGlobals().find(
      (k) => !before.has(k) && typeof globalThis[k]?.diff === "function",
    );
    if (!key) throw new Error("wasm registered no diff() global");
    const api = globalThis[key];

    // Whether the handler says it can merge (its `info` capabilities, FHR
    // SPEC §7). A build that predates the declaration says nothing, which is
    // not a yes: the merge path treats it as unable to merge.
    let semanticMerge = false;
    // The optional preview call (FHR SPEC §7): present only on handlers that
    // declare one, and its media type is the handler's own `info` answer.
    let previewType = null;
    try {
      const info = JSON.parse(api.info());
      semanticMerge = info.capabilities?.semanticMerge === true;
      if (typeof api.preview === "function") previewType = info.preview || null;
    } catch {
      semanticMerge = false;
      previewType = null;
    }

    parentPort.on("message", (msg) => {
      if (!msg) return;
      try {
        let raw;
        if (msg.type === "diff") {
          raw = api.diff(msg.base, msg.head); // Uint8Arrays in, JSON string out
        } else if (msg.type === "merge") {
          // Uint8Arrays in, {blob: base64, conflicts?} JSON string out.
          raw = api.merge(msg.base, msg.ours, msg.theirs);
        } else if (msg.type === "preview") {
          if (!previewType) throw new Error("handler has no preview");
          // Uint8Array in; {mediaType, blob: Uint8Array} or {error} out. The
          // bytes are transferred, not copied: a preview can be as large as
          // the model.
          const out = api.preview(msg.blob);
          if (out.error) throw new Error(out.error);
          const bytes = out.blob;
          parentPort.postMessage({ type: "result", id: msg.id, bytes, mediaType: out.mediaType }, [bytes.buffer]);
          return;
        } else {
          return;
        }
        parentPort.postMessage({ type: "result", id: msg.id, raw });
      } catch (e) {
        parentPort.postMessage({ type: "result", id: msg.id, error: String((e && e.message) || e) });
      }
    });

    parentPort.postMessage({ type: "ready", semanticMerge, previewType });
  } catch (e) {
    parentPort.postMessage({ type: "init-error", error: String((e && e.message) || e) });
  }
})();
