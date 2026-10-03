/**
 * Handler previews for renderers (FHR SPEC §7 `preview`): what the viewers
 * pass as MountProps.previews. Previews are best-effort — a renderer must
 * degrade without them — so a failed side is left out rather than failing the
 * view, and a handler the API says has no preview is not asked again this
 * session (the blob view would otherwise ask once per .glb it opens).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetPreviewMemo, loadServerPreviews, previewRef } from "../lib/previews";
import { ApiError, type fetchPreview } from "../api";

type Fetcher = typeof fetchPreview;

const glb = (text: string) => new Blob([text], { type: "model/gltf-binary" });

beforeEach(() => {
  __resetPreviewMemo();
  let n = 0;
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => `blob:preview-${++n}`, revokeObjectURL: () => {} });
});

describe("loadServerPreviews", () => {
  it("fetches each given side and hands back object-URL refs", async () => {
    const fetcher = vi.fn<Fetcher>(async (_t, _h, _r, _p, sha) => ({ kind: "ok", blob: glb(`glb of ${sha}`) }));
    const urls: string[] = [];
    const previews = await loadServerPreviews(null, "alice", "models", "desk.obj", { base: "b1", head: "h1" }, "obj", urls, fetcher);
    expect(previews).toEqual({
      base: { url: expect.stringMatching(/^blob:/), size: "glb of b1".length },
      head: { url: expect.stringMatching(/^blob:/), size: "glb of h1".length },
    });
    expect(urls).toHaveLength(2);
    expect(fetcher.mock.calls.map((c) => c[4])).toEqual(["b1", "h1"]);
  });

  it("fetches the base side at basePath for a renamed file (#201)", async () => {
    const fetcher = vi.fn<Fetcher>(async (_t, _h, _r, _p, sha) => ({ kind: "ok", blob: glb(`glb of ${sha}`) }));
    await loadServerPreviews(null, "alice", "models", "parts/desk.obj", { base: "b1", head: "h1", basePath: "desk.obj" }, "obj", [], fetcher);
    const pathBySha = Object.fromEntries(fetcher.mock.calls.map((c) => [c[4], c[3]]));
    expect(pathBySha).toEqual({ b1: "desk.obj", h1: "parts/desk.obj" });
  });

  it("leaves out a side that is absent or failed, and answers undefined when none worked", async () => {
    const fetcher = vi.fn<Fetcher>(async (_t, _h, _r, _p, sha) => {
      if (sha === "bad") throw new ApiError(422, "The handler could not preview this file");
      return { kind: "ok", blob: glb("ok") };
    });
    const one = await loadServerPreviews(null, "a", "r", "x.obj", { base: null, head: "h1" }, "obj", [], fetcher);
    expect(one).toEqual({ head: { url: expect.any(String), size: 2 } });
    const none = await loadServerPreviews(null, "a", "r", "x.obj", { base: "bad" }, "obj", [], fetcher);
    expect(none).toBeUndefined();
  });

  it("stops asking about a handler the API says has no preview", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ({ kind: "none", handlerId: "gltf-scene" }));
    expect(await loadServerPreviews(null, "a", "r", "m.glb", { head: "h1" }, "gltf-scene", [], fetcher)).toBeUndefined();
    expect(await loadServerPreviews(null, "a", "r", "n.glb", { head: "h2" }, "gltf-scene", [], fetcher)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("previewRef", () => {
  it("wraps in-browser preview bytes (Tier B) with their media type", () => {
    const urls: string[] = [];
    const ref = previewRef(new Uint8Array([1, 2, 3]), "model/gltf-binary", urls);
    expect(ref).toEqual({ url: urls[0], size: 3 });
  });
});
