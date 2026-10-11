/**
 * Routing pins for the standalone FHR file viewer (the blob-view counterpart
 * of the diff registry's semantic routing).
 *
 * Two properties matter and are asserted separately, because each has its own
 * failure mode:
 *
 * 1. Manifest knowledge wins: an extension the manifest advertises routes to
 *    FhrFileViewer regardless of static registrations — otherwise a format
 *    could be "supported" in diffs and mojibake in the file view.
 * 2. The floor without a manifest is honest: `.glb` falls back to the binary
 *    card, never to CodeViewer decoding model bytes as text. `.gltf` stays
 *    with CodeViewer — it IS JSON, and showing it as text is correct when the
 *    manifest is unavailable.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const { getFhrFormats } = vi.hoisted(() => ({ getFhrFormats: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getFhrFormats };
});

import {
  extensionKey,
  isSemanticFilename,
  resolveFileViewer,
  semanticViewExtensions,
} from "../views/fileViewerRegistry";
import { drawsMode } from "../lib/rendererBundle";
import { FhrFileViewer } from "../views/viewers/FhrFileViewer";
import { CodeViewer } from "../views/viewers/CodeViewer";
import { FallbackFileViewer } from "../views/viewers/FallbackFileViewer";
import {
  loadSemanticExtensionsSettled,
  loadSemanticFormats,
  resetSemanticExtensionsCache,
} from "../lib/fhrFormats";

const SEMANTIC = new Set(["glb", "gltf"]);

describe("resolveFileViewer with semantic extensions", () => {
  it("routes a manifest-advertised extension to FhrFileViewer", () => {
    expect(resolveFileViewer("mouse.glb", SEMANTIC)).toBe(FhrFileViewer);
    expect(resolveFileViewer("scene.gltf", SEMANTIC)).toBe(FhrFileViewer);
    // Case-insensitive, same as every other registry key.
    expect(resolveFileViewer("MOUSE.GLB", SEMANTIC)).toBe(FhrFileViewer);
  });

  it("manifest routing beats static registrations", () => {
    // .gltf is statically CodeViewer-eligible (JSON), but the manifest wins.
    expect(resolveFileViewer("scene.gltf", SEMANTIC)).toBe(FhrFileViewer);
  });

  it("leaves non-semantic files with their base viewers", () => {
    expect(resolveFileViewer("readme.txt", SEMANTIC)).toBe(CodeViewer);
    expect(resolveFileViewer("archive.zip", SEMANTIC)).toBe(FallbackFileViewer);
  });

  it("without a manifest, .glb gets the binary card and .gltf stays text", () => {
    // Empty set = manifest unavailable; also the omitted-argument form.
    expect(resolveFileViewer("mouse.glb", new Set())).toBe(FallbackFileViewer);
    expect(resolveFileViewer("mouse.glb")).toBe(FallbackFileViewer);
    expect(resolveFileViewer("scene.gltf")).toBe(CodeViewer);
  });

  it("isSemanticFilename matches the resolver's routing decision", () => {
    expect(isSemanticFilename("mouse.glb", SEMANTIC)).toBe(true);
    expect(isSemanticFilename("readme.md", SEMANTIC)).toBe(false);
    // Extensionless files key on the whole name and are never semantic.
    expect(isSemanticFilename("Dockerfile", SEMANTIC)).toBe(false);
  });
});

describe("loadSemanticFormats", () => {
  beforeEach(() => {
    resetSemanticExtensionsCache();
    getFhrFormats.mockReset();
  });
  afterEach(() => {
    resetSemanticExtensionsCache();
  });

  it("normalizes manifest keys and preserves handler ids", async () => {
    getFhrFormats.mockResolvedValue({ ".GLTF": "gltf-scene", ".glb": "gltf-scene" });
    const formats = await loadSemanticFormats();
    expect(formats.get("gltf")).toBe("gltf-scene");
    expect(formats.get("glb")).toBe("gltf-scene");
    expect(formats.has(".glb")).toBe(false);
  });

  it("fetches once for repeated callers", async () => {
    getFhrFormats.mockResolvedValue({ ".glb": "gltf-scene" });
    await loadSemanticFormats();
    await loadSemanticFormats();
    expect(getFhrFormats).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection — the next call retries", async () => {
    getFhrFormats.mockRejectedValueOnce(new Error("manifest 503"));
    await expect(loadSemanticFormats()).rejects.toThrow("manifest 503");
    getFhrFormats.mockResolvedValue({ ".glb": "gltf-scene" });
    const formats = await loadSemanticFormats();
    expect(formats.get("glb")).toBe("gltf-scene");
    expect(getFhrFormats).toHaveBeenCalledTimes(2);
  });

  // BlobViewer holds its text fetch until this settles; a rejection that
  // propagated would leave the blob view waiting forever, so the settled
  // variant MUST resolve (empty) on manifest failure — files then degrade to
  // their base viewers, which is the pre-manifest behavior.
  it("the settled variant resolves empty on manifest failure instead of rejecting", async () => {
    getFhrFormats.mockRejectedValue(new Error("manifest 503"));
    const extensions = await loadSemanticExtensionsSettled();
    expect(extensions.size).toBe(0);
  });
});

// 3. A renderer that draws diffs only (SPEC-RENDERING §2b: `modes` omits "view")
//    hands a single file back, and the file is then routed as if the manifest
//    did not list its extension — to the code view for a text format, not to an
//    empty "No diff provided." panel.
describe("renderers that draw diffs only", () => {
  it("drawsMode reads the bundle's modes, absent meaning all three", () => {
    expect(drawsMode({}, "view")).toBe(true);
    expect(drawsMode({ modes: ["view", "diff"] }, "view")).toBe(true);
    expect(drawsMode({ modes: ["diff"] }, "view")).toBe(false);
    expect(drawsMode({ modes: ["diff"] }, "diff")).toBe(true);
  });

  it("a declined extension leaves the FHR viewer's set, and only that one", () => {
    const manifest = new Set(["glb", "csv", "ipynb"]);
    const open = semanticViewExtensions(manifest, new Set(["csv"]));
    expect([...open].sort()).toEqual(["glb", "ipynb"]);
    expect(manifest.has("csv")).toBe(true); // the manifest's own set is untouched
    expect(semanticViewExtensions(manifest, new Set())).toBe(manifest);
  });

  it("a declined text format routes to the code view; a model keeps the FHR viewer", () => {
    const open = semanticViewExtensions(new Set(["glb", "csv"]), new Set([extensionKey("parts.CSV")]));
    expect(isSemanticFilename("parts.csv", open)).toBe(false);
    expect(resolveFileViewer("parts.csv", open)).toBe(CodeViewer);
    expect(resolveFileViewer("mouse.glb", open)).toBe(FhrFileViewer);
  });
});
