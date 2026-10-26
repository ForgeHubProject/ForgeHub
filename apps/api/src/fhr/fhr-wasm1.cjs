"use strict";
// fhr-wasm-1 (FHR SPEC §7): the wasm handler contract for every language. This
// is ForgeHub's server-side host, used by wasm-worker.cjs; it follows FHR's
// reference host (packages/wasm-host), and apps/web/src/lib/fhrWasm1.ts is its
// browser twin. Plain CJS, like the worker, so it loads under tsx and node alike.
//
// A module exports memory, fhr_alloc, fhr_free and fhr_call (and optionally
// _initialize). A request and a response are both
// [u32 header length, little-endian][JSON header][blobs, back to back]; blobs
// travel as raw bytes. A module may import a sandboxed WASI preview 1 — no
// files, no network, no environment or arguments — and nothing else.

const REQUIRED = ["memory", "fhr_alloc", "fhr_free", "fhr_call"];

/** Whether a compiled module is an fhr-wasm-1 handler (rather than a Go GOOS=js build). */
function isFhr1(module) {
  const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  return REQUIRED.every((n) => names.has(n));
}

/** An {"error": …} answer: the handler refused or failed the call. */
class HandlerError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeRequest(op, blobs, params) {
  const header = encoder.encode(JSON.stringify({ ...params, op, blobs: blobs.map((b) => b.length) }));
  const out = new Uint8Array(4 + header.length + blobs.reduce((n, b) => n + b.length, 0));
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  let at = 4 + header.length;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function decodeResponse(response) {
  if (response.length < 4) throw new Error(`fhr-wasm-1 response too short: ${response.length} bytes`);
  const n = new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(0, true);
  if (n > response.length - 4) throw new Error("fhr-wasm-1 response header overruns the response");
  const header = JSON.parse(decoder.decode(response.subarray(4, 4 + n)));
  if (typeof header.error === "string") throw new HandlerError(header.error);
  const blobs = [];
  let at = 4 + n;
  for (const len of header.blobs || []) {
    if (len < 0 || at + len > response.length) throw new Error("fhr-wasm-1 response blob overruns the response");
    blobs.push(response.subarray(at, at + len));
    at += len;
  }
  return { result: header.result, blobs };
}

// WASI errno values the sandbox answers with.
const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/**
 * The WASI preview 1 a handler gets: clocks, randomness and stdout/stderr for
 * diagnostics (handed to onLog line by line). No preopened directories, no
 * network, empty environment and arguments; every other function answers
 * ENOSYS. proc_exit throws, ending the call rather than the host.
 */
function sandboxWasi(memory, onLog) {
  const view = () => new DataView(memory().buffer);
  const pending = { 1: "", 2: "" };
  const known = {
    args_sizes_get: (count, size) => (view().setUint32(count, 0, true), view().setUint32(size, 0, true), ESUCCESS),
    args_get: () => ESUCCESS,
    environ_sizes_get: (count, size) => (view().setUint32(count, 0, true), view().setUint32(size, 0, true), ESUCCESS),
    environ_get: () => ESUCCESS,
    clock_time_get: (id, _precision, out) => {
      const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
      view().setBigUint64(out, ns, true);
      return ESUCCESS;
    },
    random_get: (ptr, len) => {
      const bytes = new Uint8Array(memory().buffer, ptr, len);
      for (let at = 0; at < len; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(len, at + 65536)));
      return ESUCCESS;
    },
    fd_write: (fd, iovs, iovsLen, written) => {
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) pending[fd] += decoder.decode(new Uint8Array(memory().buffer, ptr, len));
        total += len;
      }
      for (const f of [1, 2]) {
        const lines = pending[f].split("\n");
        pending[f] = lines.pop();
        for (const line of lines) onLog(line);
      }
      view().setUint32(written, total, true);
      return fd === 1 || fd === 2 ? ESUCCESS : EBADF;
    },
    sched_yield: () => ESUCCESS,
    // Nothing to wait for in a sandbox: report no events, so a sleeping module
    // re-checks its clock rather than blocking the worker.
    poll_oneoff: (_in, _out, _n, nevents) => (view().setUint32(nevents, 0, true), ESUCCESS),
    proc_exit: (code) => {
      throw new Error(`the handler exited with code ${code}`);
    },
    fd_prestat_get: () => EBADF,
  };
  return new Proxy(known, { get: (k, name) => k[name] || (() => ENOSYS) });
}

/**
 * Instantiate an fhr-wasm-1 module and return `call(op, blobs, params)` →
 * {result, blobs}, throwing HandlerError for an {"error": …} answer. Any
 * import outside the sandboxed WASI is refused.
 */
async function instantiateFhr1(module, onLog = () => {}) {
  let memory = null;
  const imports = {};
  const wanted = WebAssembly.Module.imports(module);
  for (const i of wanted) {
    if (i.module !== "wasi_snapshot_preview1") {
      throw new Error(`the module imports ${i.module}.${i.name}; fhr-wasm-1 hosts provide only a sandboxed WASI`);
    }
  }
  if (wanted.length) {
    const wasi = sandboxWasi(() => memory, onLog);
    imports.wasi_snapshot_preview1 = Object.fromEntries(wanted.map((i) => [i.name, wasi[i.name]]));
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const x = instance.exports;
  memory = x.memory;
  if (typeof x._initialize === "function") x._initialize();

  return function call(op, blobs = [], params = {}) {
    const request = encodeRequest(op, blobs, params);
    const ptr = x.fhr_alloc(request.length) >>> 0;
    // Each call into the module may grow its memory: view it afresh every time.
    new Uint8Array(x.memory.buffer, ptr, request.length).set(request);
    let packed;
    try {
      packed = BigInt.asUintN(64, x.fhr_call(ptr, request.length));
    } finally {
      x.fhr_free(ptr, request.length);
    }
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const response = new Uint8Array(x.memory.buffer, outPtr, outLen).slice();
    x.fhr_free(outPtr, outLen);
    return decodeResponse(response);
  };
}

module.exports = { isFhr1, instantiateFhr1, HandlerError, encodeRequest, decodeResponse, sandboxWasi };
