// Type surface for the vendored Go wasm runtime (wasm_exec.js — the same
// upstream file the API runs in its wasm worker). Importing the module is a
// side effect: it installs `Go` (plus minimal fs/process stubs) on globalThis.
// Only the members ForgeHub touches are declared.

export interface GoRuntime {
  importObject: WebAssembly.Imports;
  /** Resolves when the Go program exits; a handler parks on select{} forever. */
  run(instance: WebAssembly.Instance): Promise<void>;
}

export interface GoConstructor {
  new (): GoRuntime;
}
