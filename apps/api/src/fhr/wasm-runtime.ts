import { createRequire } from "node:module";
import type { StructuredDiff } from "../handlers/types.js";

// Vendored Go wasm glue (defines globalThis.Go). Kept as .cjs and copied to
// dist by the build; loaded for its side effect.
const require = createRequire(import.meta.url);

// Raw JS surface a built FHR wasm handler registers on globalThis
// (see handler-gltf-scene/wasm.go). Each fn takes Uint8Array args and returns a
// JSON string — either the result or { "error": "..." }.
type WasmApi = {
  diff(base: Uint8Array, head: Uint8Array): string;
  merge?(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): string;
  info?(): string;
};

export type WasmHandler = {
  diff(base: Buffer, head: Buffer): StructuredDiff;
};

function handlerGlobals(): string[] {
  return Object.keys(globalThis).filter((k) => k.startsWith("__forgeHandler"));
}

/**
 * Instantiate an official FHR handler's WebAssembly build and return a
 * typed diff() wrapper.
 *
 * Security: the wasm runs with wasm_exec's built-in minimal fs stub — we
 * deliberately do NOT wire Node's fs/child_process into globalThis, so the
 * module is confined to pure computation (no filesystem, no network). We only
 * ever run *official* handlers here (see official-handlers.ts); community
 * handlers are never fetched or executed server-side. Hardening follow-up:
 * run in a Worker with an execution timeout so a crafted input cannot hang the
 * event loop (a synchronous wasm call can't be interrupted from JS).
 */
// WebAssembly + the vendored Go runtime are inherently dynamic; type the
// interop boundary loosely rather than pulling the DOM lib into the server.
type GoRuntime = { importObject: unknown; run(instance: unknown): Promise<void> };
const glob = globalThis as unknown as Record<string, unknown>;

export async function instantiateWasmHandler(bytes: Buffer, handlerId: string): Promise<WasmHandler> {
  require("./wasm_exec.cjs"); // idempotent; sets globalThis.Go (+ fs/process stubs if unset)
  const Go = glob["Go"] as (new () => GoRuntime) | undefined;
  if (!Go) throw new Error("wasm_exec did not define Go");
  const wasm = glob["WebAssembly"] as { instantiate(b: Buffer, imports: unknown): Promise<{ instance: unknown }> };

  const before = new Set(handlerGlobals());
  const go = new Go();
  const { instance } = await wasm.instantiate(bytes, go.importObject);
  // main() registers the api synchronously, then parks on select{} — so we
  // must NOT await run(); the globals are set by the time it yields.
  void go.run(instance);

  const key = handlerGlobals().find(
    (k) => !before.has(k) && typeof (glob[k] as { diff?: unknown } | undefined)?.diff === "function",
  );
  if (!key) throw new Error(`wasm handler ${handlerId} registered no diff() global`);
  const api = glob[key] as WasmApi;

  return {
    diff(base: Buffer, head: Buffer): StructuredDiff {
      const raw = api.diff(base, head); // Buffer is a Uint8Array
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`wasm ${handlerId}: unparseable diff output`);
      }
      const obj = parsed as { error?: string; format?: string; changes?: StructuredDiff["changes"] };
      if (obj.error) throw new Error(`wasm ${handlerId}: ${obj.error}`);
      return { version: "1.0", format: obj.format ?? handlerId, changes: obj.changes ?? [] };
    },
  };
}
