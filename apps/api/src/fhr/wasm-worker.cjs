"use strict";
// Worker that runs one official FHR wasm handler, isolated from the API's main
// event loop (SPEC-RENDERING §7d hardening). A synchronous wasm call can't be
// interrupted from JS, so it runs here where a hang blocks only this worker —
// which the main thread terminates on timeout. Plain CJS so it runs directly
// under both tsx (dev) and node (prod) with no TypeScript loader in the worker.
//
// Two kinds of module run here, told apart by their exports:
//   * fhr-wasm-1 (FHR SPEC §7): the contract any language implements, hosted
//     by fhr-wasm1.cjs with a sandboxed WASI;
//   * a Go GOOS=js build, the older Go-only form, started with Go's wasm_exec.
// Both are wrapped in the same `api` shape below, so the message handling — and
// the runtime on the main thread — doesn't care which one it is.
const { parentPort, workerData } = require("node:worker_threads");
const { isFhr1, instantiateFhr1, HandlerError } = require("./fhr-wasm1.cjs");

function handlerGlobals() {
  return Object.keys(globalThis).filter((k) => k.startsWith("__forgeHandler"));
}

/** A Go GOOS=js build: run it, and pick up the __forgeHandler* global it registers. */
async function goApi(module) {
  require("./wasm_exec.cjs"); // sets this worker's globalThis.Go (+ fs/process stubs)
  const before = new Set(handlerGlobals());
  const go = new globalThis.Go();
  const instance = await WebAssembly.instantiate(module, go.importObject);
  void go.run(instance); // registers the api synchronously, then parks on select{}
  const key = handlerGlobals().find((k) => !before.has(k) && typeof globalThis[k]?.diff === "function");
  if (!key) throw new Error("wasm registered no diff() global");
  const go_ = globalThis[key];
  return {
    info: go_.info,
    diff: go_.diff,
    // {blob: base64, conflicts?} JSON string out.
    merge: (base, ours, theirs) => ({ raw: go_.merge(base, ours, theirs) }),
    preview: typeof go_.preview === "function" ? go_.preview : undefined,
    import: typeof go_.import === "function" ? go_.import : undefined,
    export: typeof go_.export === "function" ? go_.export : undefined,
  };
}

/** An fhr-wasm-1 module, answering in the shapes goApi does. */
async function fhr1Api(module) {
  const call = await instantiateFhr1(module, (line) => parentPort.postMessage({ type: "log", line }));
  // JSON-string answers, {"error": …} for a refusal — as a Go build gives them.
  const json = (fn) => {
    try {
      return JSON.stringify(fn());
    } catch (e) {
      if (e instanceof HandlerError) return JSON.stringify({ error: e.message });
      throw e;
    }
  };
  // Object answers carrying a file: {…, blob} or {error}.
  const withBlob = (fn) => {
    try {
      const { result, blobs } = fn();
      return { ...(result || {}), blob: blobs[0] };
    } catch (e) {
      if (e instanceof HandlerError) return { error: e.message };
      throw e;
    }
  };
  return {
    info: () => json(() => call("info").result),
    diff: (base, head) => json(() => call("diff", [base, head]).result),
    // The merged blob comes back raw (no base64), beside the conflicts JSON.
    merge: (base, ours, theirs) => {
      try {
        const { result, blobs } = call("merge", [base, ours, theirs]);
        return { raw: JSON.stringify(result || {}), bytes: blobs[0] };
      } catch (e) {
        if (e instanceof HandlerError) return { raw: JSON.stringify({ error: e.message }) };
        throw e;
      }
    },
    preview: (blob) => withBlob(() => call("preview", [blob])),
    import: (blob) => withBlob(() => call("import", [blob])),
    export: (blob, format) => withBlob(() => call("export", [blob], format ? { format } : {})),
  };
}

/** Post the bytes without copying them: a preview or a merge can be as large as the model. */
function postBytes(msg, bytes) {
  // A view into a larger buffer can't be transferred alone; copy it out first.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  parentPort.postMessage({ ...msg, bytes: own }, [own.buffer]);
}

(async () => {
  try {
    const { bytes } = workerData;
    const module = await WebAssembly.compile(bytes);
    const fhr1 = isFhr1(module);
    const api = fhr1 ? await fhr1Api(module) : await goApi(module);

    // Whether the handler says it can merge (its `info` capabilities, FHR
    // SPEC §7). A build that predates the declaration says nothing, which is
    // not a yes: the merge path treats it as unable to merge.
    let semanticMerge = false;
    // The optional preview call (FHR SPEC §7): present only on handlers that
    // declare one, and its media type is the handler's own `info` answer.
    let previewType = null;
    // The optional import/export calls (FHR SPEC §7): the 3D family's
    // transcoding through glTF. Offered only when the build has the call AND
    // declares it, so neither a stale declaration nor a stray function makes
    // a handler look able to convert.
    let canImport = false;
    let canExport = false;
    let formats = [];
    try {
      const info = JSON.parse(api.info());
      semanticMerge = info.capabilities?.semanticMerge === true;
      if (typeof api.preview === "function") previewType = info.preview || null;
      canImport = typeof api.import === "function" && info.capabilities?.import === true;
      canExport = typeof api.export === "function" && info.capabilities?.export === true;
      formats = Array.isArray(info.formats) ? info.formats : [];
    } catch {
      semanticMerge = false;
      previewType = null;
      canImport = false;
      canExport = false;
      formats = [];
    }

    parentPort.on("message", (msg) => {
      if (!msg) return;
      try {
        if (msg.type === "diff") {
          // Uint8Arrays in, JSON string out.
          parentPort.postMessage({ type: "result", id: msg.id, raw: api.diff(msg.base, msg.head) });
        } else if (msg.type === "merge") {
          const { raw, bytes } = api.merge(msg.base, msg.ours, msg.theirs);
          if (bytes) postBytes({ type: "result", id: msg.id, raw }, bytes);
          else parentPort.postMessage({ type: "result", id: msg.id, raw });
        } else if (msg.type === "preview") {
          if (!previewType) throw new Error("handler has no preview");
          // Uint8Array in; {mediaType, blob: Uint8Array} or {error} out.
          const out = api.preview(msg.blob);
          if (out.error) throw new Error(out.error);
          postBytes({ type: "result", id: msg.id, mediaType: out.mediaType }, out.blob);
        } else if (msg.type === "import") {
          if (!canImport) throw new Error("handler cannot import");
          // Uint8Array in; {mediaType, blob: Uint8Array (a GLB)} or {error} out.
          const out = api.import(msg.blob);
          if (out.error) throw new Error(out.error);
          postBytes({ type: "result", id: msg.id, mediaType: out.mediaType }, out.blob);
        } else if (msg.type === "export") {
          if (!canExport) throw new Error("handler cannot export");
          // A GLB Uint8Array and the target extension in; {blob: Uint8Array} or {error} out.
          const out = api.export(msg.blob, msg.format);
          if (out.error) throw new Error(out.error);
          postBytes({ type: "result", id: msg.id }, out.blob);
        }
      } catch (e) {
        // A trap means the module crashed mid-call and its memory is in an
        // unknown state: say so, and the runtime drops this worker, so the
        // next call starts a fresh instance.
        const crashed = e instanceof WebAssembly.RuntimeError;
        parentPort.postMessage({ type: "result", id: msg.id, error: String((e && e.message) || e), crashed });
      }
    });

    parentPort.postMessage({ type: "ready", semanticMerge, previewType, canImport, canExport, formats, abi: fhr1 ? "fhr-wasm-1" : "go-js" });
  } catch (e) {
    parentPort.postMessage({ type: "init-error", error: String((e && e.message) || e) });
  }
})();
