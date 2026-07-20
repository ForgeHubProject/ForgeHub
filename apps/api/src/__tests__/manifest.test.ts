/**
 * FHR manifest module tests. The upstream fetch is stubbed so no network is
 * used; we assert format→handler / wasm / renderer resolution, TTL caching (a
 * single upstream fetch serves many calls), and stale-on-error (a failed
 * refresh keeps serving the last good manifest).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  officialFormats,
  handlerWasmUrl,
  rendererUrl,
  rendererIds,
  parseManifest,
  __resetManifest,
} from "../fhr/manifest.js";

// Mirrors the real fhr-official manifest shape, including native-binary keys the
// parser must ignore (ForgeHub only consumes the wasm build + renderer bundle).
const FIXTURE = `
name = "fhr-official"
url  = "https://github.com/forgehubproject/fhr"

[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }
".glb"  = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"linux-amd64"   = "https://cdn.test/fhr/forge-handler-gltf-scene_linux-amd64"
"windows-amd64" = "https://cdn.test/fhr/forge-handler-gltf-scene_windows-amd64.exe"
"wasm"          = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

const realFetch = globalThis.fetch;

function stubFetchOk(body = FIXTURE) {
  const fn = vi.fn(async () => new Response(body, { status: 200 }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  __resetManifest();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("parseManifest", () => {
  it("projects formats, wasm and renderer URLs; ignores native binaries", () => {
    const m = parseManifest(FIXTURE);
    expect(m.formats.get(".gltf")).toBe("gltf-scene");
    expect(m.formats.get(".glb")).toBe("gltf-scene");
    expect(m.wasmUrls.get("gltf-scene")).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
    expect(m.rendererUrls.get("gltf-scene")).toBe("https://cdn.test/fhr/renderer-gltf-scene.js");
    // native binary keys are not renderer/wasm outputs — no spurious entries
    expect([...m.rendererUrls.keys()]).toEqual(["gltf-scene"]);
  });
});

describe("manifest accessors (stubbed fetch)", () => {
  it("resolves formats, wasm and renderer URLs from the fetched manifest", async () => {
    stubFetchOk();
    expect((await officialFormats()).get(".gltf")).toBe("gltf-scene");
    expect(await handlerWasmUrl("gltf-scene")).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
    expect(await rendererUrl("gltf-scene")).toBe("https://cdn.test/fhr/renderer-gltf-scene.js");
    expect(await rendererIds()).toEqual(["gltf-scene"]);
  });

  it("returns null for handlers the manifest doesn't declare", async () => {
    stubFetchOk();
    expect(await handlerWasmUrl("nope")).toBeNull();
    expect(await rendererUrl("nope")).toBeNull();
  });

  it("caches within the TTL: a single upstream fetch serves many calls", async () => {
    const fn = stubFetchOk();
    await officialFormats();
    await handlerWasmUrl("gltf-scene");
    await rendererUrl("gltf-scene");
    await officialFormats();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("serves the last good manifest when a refresh fails (stale-on-error)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const okFn = stubFetchOk();
    expect((await officialFormats()).get(".gltf")).toBe("gltf-scene");
    expect(okFn).toHaveBeenCalledTimes(1);

    // Upstream now breaks; advance past the TTL so the cache is stale and a
    // refresh is attempted — it fails, and the last good manifest is served.
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
    expect((await officialFormats()).get(".gltf")).toBe("gltf-scene");
    expect(await handlerWasmUrl("gltf-scene")).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
  });

  it("rejects on a cold start when the manifest is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(officialFormats()).rejects.toThrow();
  });
});
