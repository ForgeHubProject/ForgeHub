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

    parentPort.on("message", (msg) => {
      if (!msg || msg.type !== "diff") return;
      try {
        const raw = api.diff(msg.base, msg.head); // Uint8Array in, JSON string out
        parentPort.postMessage({ type: "result", id: msg.id, raw });
      } catch (e) {
        parentPort.postMessage({ type: "result", id: msg.id, error: String((e && e.message) || e) });
      }
    });

    parentPort.postMessage({ type: "ready" });
  } catch (e) {
    parentPort.postMessage({ type: "init-error", error: String((e && e.message) || e) });
  }
})();
