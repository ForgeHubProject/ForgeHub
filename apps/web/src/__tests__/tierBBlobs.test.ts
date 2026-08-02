/**
 * Regression tests for the Tier-B blob pairing (#66 P4 review). Tier B used to
 * fetch both blobs in one Promise.all guarded only on the base SHA being
 * non-null — but a SHA is not a blob. An added file has a real parent SHA with
 * no blob in it, a deleted file has no blob at head, and a rename has neither
 * at the new path on the base side; /rawblob 404s in all three cases, the
 * Promise.all rejected, and the viewer's `isFormatNotSupported` catch (which is
 * exactly "404") swallowed it into a silent plain-text fallback. Every added,
 * deleted and renamed file was affected.
 *
 * The pairing is pure enough to test with an injected fetcher, which is the
 * point: nothing else in the diff exercised this path.
 */
import { describe, it, expect, vi } from "vitest";
import { loadTierBBlobs } from "../views/diffViewers/FhrFileDiffViewer";
import { ApiError, type FileDiffMeta } from "../api";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

type Meta = Pick<FileDiffMeta, "baseSha" | "headSha" | "baseSize" | "headSize">;

const meta = (over: Partial<Meta> = {}): Meta => ({
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  baseSize: 100,
  headSize: 120,
  ...over,
});

/** A fetcher that serves the listed SHAs and 404s like /rawblob for the rest. */
function fetcher(present: Record<string, string>) {
  return vi.fn(async (_t: string | null, _h: string, _r: string, _p: string, sha: string) => {
    const body = present[sha];
    if (body === undefined) throw new ApiError(404, "File not found at this commit");
    return new Blob([body]);
  });
}

const load = (m: Meta, f: ReturnType<typeof fetcher>) =>
  loadTierBBlobs(null, "alice", "scene", "model.gltf", m, f);

describe("loadTierBBlobs", () => {
  it("fetches both sides when both blobs exist", async () => {
    const f = fetcher({ [BASE_SHA]: "base", [HEAD_SHA]: "head" });
    const { base, head } = await load(meta(), f);
    expect(await base!.text()).toBe("base");
    expect(await head!.text()).toBe("head");
  });

  it("an ADDED file resolves with an empty base instead of rejecting", async () => {
    // Real parent SHA, no blob in it — exactly what filediff-meta returns.
    const f = fetcher({ [HEAD_SHA]: "head" });
    const { base, head } = await load(meta({ baseSize: null }), f);
    expect(base).toBeNull();
    expect(await head!.text()).toBe("head");
    // The absent side isn't even requested — the declared size already said so.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a DELETED file resolves with an empty head instead of rejecting", async () => {
    const f = fetcher({ [BASE_SHA]: "base" });
    const { base, head } = await load(meta({ headSize: null }), f);
    expect(await base!.text()).toBe("base");
    expect(head).toBeNull();
  });

  it("a RENAMED file resolves with an empty base (the blob is at the old path)", async () => {
    const f = fetcher({ [HEAD_SHA]: "head" });
    const { base, head } = await load(meta({ baseSize: null }), f);
    expect(base).toBeNull();
    expect(head).not.toBeNull();
  });

  it("tolerates a 404 even when a size claimed the blob was there", async () => {
    const f = fetcher({ [HEAD_SHA]: "head" });
    const { base, head } = await load(meta(), f);
    expect(base).toBeNull();
    expect(await head!.text()).toBe("head");
  });

  it("propagates a real failure rather than pretending the blob is empty", async () => {
    const f = vi.fn(async () => {
      throw new ApiError(500, "boom");
    });
    await expect(load(meta(), f as never)).rejects.toThrow("boom");
  });

  it("rejects when neither side has a blob — that is not a diffable pair", async () => {
    const f = fetcher({});
    await expect(load(meta({ baseSize: null, headSize: null }), f)).rejects.toThrow(
      "File not found at either revision",
    );
  });

  it("skips the base fetch entirely for a root commit (no base SHA)", async () => {
    const f = fetcher({ [HEAD_SHA]: "head" });
    const { base } = await load(meta({ baseSha: null, baseSize: null }), f);
    expect(base).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
