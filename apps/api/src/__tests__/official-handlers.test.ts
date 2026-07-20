import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  officialHandlerId,
  officialWasmDiff,
  __resetOfficialHandlers,
  type OfficialHandlerDeps,
} from "../fhr/official-handlers.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import type { StructuredDiff } from "../handlers/types.js";

// A stubbed manifest so no test touches the network. The wasm URL ends with the
// canonical `forge-handler-<id>.wasm` name the wasm fetch is asserted against.
const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }
".glb"  = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://example.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://example.test/fhr/renderer-gltf-scene.js"
`;

const gltfExts = new Set([".gltf", ".glb"]);
const sampleDiff: StructuredDiff = { version: "1.0", format: "gltf-scene", changes: [{ path: "n", kind: "modified" }] };

function deps(over: Partial<OfficialHandlerDeps> = {}): OfficialHandlerDeps {
  return {
    fetchImpl: vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as unknown as typeof fetch,
    instantiate: vi.fn(async () => ({ diff: async () => sampleDiff })),
    ...over,
  };
}

beforeEach(() => {
  __resetOfficialHandlers();
  __setManifestForTests(MANIFEST);
});
afterEach(() => __resetManifest());

describe("officialHandlerId", () => {
  it("maps official glTF extensions, case-insensitively", async () => {
    expect(await officialHandlerId(".gltf")).toBe("gltf-scene");
    expect(await officialHandlerId(".GLB")).toBe("gltf-scene");
  });
  it("returns null for anything not in the official set", async () => {
    expect(await officialHandlerId(".png")).toBeNull();
    expect(await officialHandlerId(".step")).toBeNull();
  });
});

describe("officialWasmDiff", () => {
  it("computes via the official wasm handler when everything resolves", async () => {
    const d = deps();
    const res = await officialWasmDiff("scene/model.gltf", gltfExts, Buffer.from("a"), Buffer.from("b"), d);
    expect(res).toEqual({ diff: sampleDiff, handlerId: "gltf-scene" });
    // fetched the official wasm asset from the manifest, not a community source
    expect(d.fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/forge-handler-gltf-scene.wasm"));
  });

  it("returns null (→ 503, no fallback) when the extension is not opted in", async () => {
    const res = await officialWasmDiff("model.gltf", new Set([".txt"]), Buffer.from("a"), Buffer.from("b"), deps());
    expect(res).toBeNull();
  });

  it("returns null for a non-official extension", async () => {
    const res = await officialWasmDiff("model.step", new Set([".step"]), Buffer.from("a"), Buffer.from("b"), deps());
    expect(res).toBeNull();
  });

  it("skips wasm for oversized blobs (DoS guard)", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024);
    const d = deps();
    const res = await officialWasmDiff("model.gltf", gltfExts, big, Buffer.from("b"), d);
    expect(res).toBeNull();
    expect(d.instantiate).not.toHaveBeenCalled();
  });

  it("returns null when the official wasm asset is missing", async () => {
    const d = deps({ fetchImpl: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch });
    const res = await officialWasmDiff("model.gltf", gltfExts, Buffer.from("a"), Buffer.from("b"), d);
    expect(res).toBeNull();
  });

  it("returns null (no fallback) when the wasm handler throws on the input", async () => {
    const d = deps({ instantiate: vi.fn(async () => ({ diff: async () => { throw new Error("bad gltf"); } })) });
    const res = await officialWasmDiff("model.gltf", gltfExts, Buffer.from("a"), Buffer.from("b"), d);
    expect(res).toBeNull();
  });

  it("memoizes the handler instance across calls", async () => {
    const d = deps();
    await officialWasmDiff("a.gltf", gltfExts, Buffer.from("a"), Buffer.from("b"), d);
    await officialWasmDiff("b.gltf", gltfExts, Buffer.from("c"), Buffer.from("d"), d);
    expect(d.instantiate).toHaveBeenCalledTimes(1);
  });
});
