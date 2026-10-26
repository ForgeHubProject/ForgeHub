/**
 * The pure wasm-instantiation logic shared by browserWasm.ts (via the worker)
 * and browserWasmWorker.ts directly — the Go runtime, WebAssembly.instantiate
 * and the global scope are injected here, so the interesting part —
 * discovering the `__forgeHandler*` global a build registers, and only the NEW
 * one — runs for real without a real wasm build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  instantiateHandler,
  instantiateOnPage,
  parseDiffOutput,
  type PageInstantiateDeps,
} from "../lib/wasmHandlerLoad";

const RAW_DIFF = JSON.stringify({
  format: "gltf-scene",
  changes: [{ path: "nodes/0", kind: "modified", label: "Cube" }],
});

describe("instantiateOnPage", () => {
  function pageDeps(
    scope: Record<string, unknown>,
    onRun: () => void,
  ): PageInstantiateDeps {
    return {
      loadGoRuntime: async () => {
        scope["Go"] = class {
          importObject = {} as WebAssembly.Imports;
          async run() {
            // A real handler registers its api synchronously, then parks.
            onRun();
            return new Promise<void>(() => {});
          }
        };
      },
      instantiateWasm: async () => ({ instance: {} as WebAssembly.Instance }),
      scope,
    };
  }

  it("returns the diff api the build registers on the page", async () => {
    const scope: Record<string, unknown> = {};
    const api = { diff: () => RAW_DIFF };
    const handler = await instantiateOnPage(
      new ArrayBuffer(8),
      "gltf-scene",
      pageDeps(scope, () => void (scope["__forgeHandlerGltfScene"] = api)),
    );
    expect(handler).toBe(api);
  });

  it("ignores a handler global that was already on the page", async () => {
    const stale = { diff: () => '{"changes":[{"path":"stale"}]}' };
    const fresh = { diff: () => RAW_DIFF };
    const scope: Record<string, unknown> = { __forgeHandlerStale: stale };
    const handler = await instantiateOnPage(
      new ArrayBuffer(8),
      "gltf-scene",
      pageDeps(scope, () => void (scope["__forgeHandlerFresh"] = fresh)),
    );
    expect(handler).toBe(fresh);
  });

  it("throws when the Go runtime failed to load", async () => {
    const scope: Record<string, unknown> = {};
    await expect(
      instantiateOnPage(new ArrayBuffer(8), "gltf-scene", {
        loadGoRuntime: async () => {},
        instantiateWasm: async () => ({ instance: {} as WebAssembly.Instance }),
        scope,
      }),
    ).rejects.toThrow("Go runtime failed to load");
  });

  it("throws when the build registers no diff() global", async () => {
    const scope: Record<string, unknown> = {};
    await expect(
      instantiateOnPage(
        new ArrayBuffer(8),
        "gltf-scene",
        pageDeps(scope, () => void (scope["__forgeHandlerBroken"] = { render: () => "" })),
      ),
    ).rejects.toThrow("registered no diff() global");
  });

  it("propagates an instantiation failure (bad wasm bytes)", async () => {
    const scope: Record<string, unknown> = {};
    const d = pageDeps(scope, () => {});
    await expect(
      instantiateOnPage(new ArrayBuffer(8), "gltf-scene", {
        ...d,
        instantiateWasm: async () => {
          throw new Error("CompileError: invalid wasm");
        },
      }),
    ).rejects.toThrow("invalid wasm");
  });
});

describe("parseDiffOutput (same contract as the server runtime)", () => {
  it("wraps changes with the wire version and defaults format to the handler id", () => {
    expect(parseDiffOutput('{"changes":[]}', "gltf-scene")).toEqual({
      version: "1.0",
      format: "gltf-scene",
      changes: [],
    });
  });

  it("prefers the handler's own format name", () => {
    expect(parseDiffOutput(RAW_DIFF, "other").format).toBe("gltf-scene");
  });

  it("defaults missing changes to an empty list", () => {
    expect(parseDiffOutput("{}", "gltf-scene").changes).toEqual([]);
  });

  it("throws on unparseable output", () => {
    expect(() => parseDiffOutput("not json", "gltf-scene")).toThrow("unparseable");
  });

  it("throws on an error payload", () => {
    expect(() => parseDiffOutput('{"error":"boom"}', "gltf-scene")).toThrow("boom");
  });
});

// fhr-wasm-1 (FHR SPEC §7) for real: test-data/fhr-wasm-1/fixture.wasm is a
// small Rust handler (answers are fixed functions of input lengths; it writes
// to stderr and draws randomness through the sandboxed WASI).
describe("instantiateHandler with an fhr-wasm-1 module", () => {
  const fixture = readFileSync(new URL("../../../../test-data/fhr-wasm-1/fixture.wasm", import.meta.url));
  const bytes = () => fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer;
  const enc = (s: string) => new TextEncoder().encode(s);

  it("answers diff and info as JSON strings, as a Go build does", async () => {
    const h = await instantiateHandler(bytes(), "fixture");
    expect(parseDiffOutput(h.diff(enc("abc"), enc("abcdef")), "fixture")).toEqual({
      version: "1.0",
      format: "fixture",
      changes: [{ path: "bytes", kind: "modified", label: "bytes", before: "3", after: "6" }],
    });
    expect(JSON.parse(h.info!())).toMatchObject({ id: "fixture", preview: "model/gltf-binary" });
  });

  it("previews with the bytes intact", async () => {
    const h = await instantiateHandler(bytes(), "fixture");
    const out = h.preview!(new Uint8Array([1, 2, 3]));
    expect(out.mediaType).toBe("model/gltf-binary");
    expect([...out.blob!]).toEqual([3, 2, 1]);
  });

  it("lets a crash surface as a wasm trap, which the worker flags so the module is dropped", async () => {
    const h = await instantiateHandler(bytes(), "fixture");
    expect(() => h.diff(enc("x"), enc("trap"))).toThrow(WebAssembly.RuntimeError);
  });
});
