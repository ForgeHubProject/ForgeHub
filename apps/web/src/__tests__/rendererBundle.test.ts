/**
 * Renderer bundles are loaded at the build the manifest names, with the build
 * in the URL path, so a new FHR release is never answered from the browser's
 * hour-long cache of the old bundle (or the old lazy 3D chunk). The import is
 * injected, so no module is fetched; the build lookup (/fhr/formats) is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { getFhrBuilds } = vi.hoisted(() => ({ getFhrBuilds: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getFhrBuilds };
});

import { API_BASE } from "../api";
import { __resetRendererBundles, loadRendererBundle, rendererBundleUrl } from "../lib/rendererBundle";

// How an FHR lite bundle finds its lazy 3D chunk (renderer-gltf-scene
// scene-renderer.ts): its own URL with the file name and any query swapped out.
const chunkUrlFrom = (bundleUrl: string, chunk: string) => bundleUrl.replace(/[^/]*(?:\?.*)?$/, chunk);

function importer() {
  return vi.fn(async (url: string) => ({ default: { handlerId: "ipynb", url } }));
}

beforeEach(() => {
  __resetRendererBundles();
  getFhrBuilds.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rendererBundleUrl", () => {
  it("puts the build in the path, so the lazy 3D chunk inherits it", () => {
    const url = rendererBundleUrl("gltf-scene", "e520cc6");
    expect(url).toBe(`${API_BASE}/renderers/e520cc6/gltf-scene`);
    expect(chunkUrlFrom(url, "renderer-gltf-scene-3d.js")).toBe(
      `${API_BASE}/renderers/e520cc6/renderer-gltf-scene-3d.js`,
    );
    // Why not ?build=: the chunk swap drops the query, and the chunk would be
    // served from the browser's cache of the previous build.
    expect(chunkUrlFrom(`${API_BASE}/renderers/gltf-scene?build=e520cc6`, "renderer-gltf-scene-3d.js")).toBe(
      `${API_BASE}/renderers/renderer-gltf-scene-3d.js`,
    );
  });

  it("falls back to the unversioned URL without a build", () => {
    expect(rendererBundleUrl("gltf-scene", null)).toBe(`${API_BASE}/renderers/gltf-scene`);
  });
});

describe("loadRendererBundle", () => {
  it("imports the bundle at the manifest's current build", async () => {
    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    const importModule = importer();
    const bundle = await loadRendererBundle("ipynb", importModule);
    expect(importModule).toHaveBeenCalledWith(`${API_BASE}/renderers/6b5162d/ipynb`);
    expect(bundle).toMatchObject({ handlerId: "ipynb" });
  });

  it("reuses one import, and one build lookup, for the same build", async () => {
    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    const importModule = importer();
    const a = await loadRendererBundle("ipynb", importModule);
    const b = await loadRendererBundle("ipynb", importModule);
    expect(b).toBe(a);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(getFhrBuilds).toHaveBeenCalledTimes(1);
  });

  it("imports the new bundle once the manifest names a new build", async () => {
    vi.useFakeTimers();
    getFhrBuilds.mockResolvedValue({ ipynb: "870c032" });
    const importModule = importer();
    await loadRendererBundle("ipynb", importModule);

    // FHR#109 republished ipynb-latest; the API's manifest refresh stamped it.
    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    // Within the lookup's lifetime the tab keeps what it loaded...
    await loadRendererBundle("ipynb", importModule);
    expect(importModule).toHaveBeenCalledTimes(1);

    // ...and past it, the new build is imported from its own URL.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await loadRendererBundle("ipynb", importModule);
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(importModule).toHaveBeenLastCalledWith(`${API_BASE}/renderers/6b5162d/ipynb`);
  });

  it("loads an unstamped handler from the unversioned URL", async () => {
    getFhrBuilds.mockResolvedValue({});
    const importModule = importer();
    await loadRendererBundle("ipynb", importModule);
    expect(importModule).toHaveBeenCalledWith(`${API_BASE}/renderers/ipynb`);
  });

  it("a failed build lookup still loads, and is asked again next time", async () => {
    getFhrBuilds.mockRejectedValueOnce(new Error("manifest 503"));
    const importModule = importer();
    await loadRendererBundle("ipynb", importModule);
    expect(importModule).toHaveBeenCalledWith(`${API_BASE}/renderers/ipynb`);

    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    await loadRendererBundle("ipynb", importModule);
    expect(getFhrBuilds).toHaveBeenCalledTimes(2);
    expect(importModule).toHaveBeenLastCalledWith(`${API_BASE}/renderers/6b5162d/ipynb`);
  });

  it("keeps the loaded bundle when a later build lookup fails", async () => {
    vi.useFakeTimers();
    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    const importModule = importer();
    const loaded = await loadRendererBundle("ipynb", importModule);

    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    getFhrBuilds.mockRejectedValue(new Error("manifest 503"));
    expect(await loadRendererBundle("ipynb", importModule)).toBe(loaded);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected import", async () => {
    getFhrBuilds.mockResolvedValue({ ipynb: "6b5162d" });
    const importModule = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ default: { handlerId: "ipynb" } });
    await expect(loadRendererBundle("ipynb", importModule)).rejects.toThrow("network");
    await expect(loadRendererBundle("ipynb", importModule)).resolves.toMatchObject({ handlerId: "ipynb" });
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});
