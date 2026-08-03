/**
 * The shared filediff-meta cache (#66 P4 review). It exists so the header pill
 * and the viewer body never ask twice for the same blob pair — but the answer
 * (blob SHAs and exact sizes) is principal-specific and, when the caller passed
 * a branch, time-specific, so the key carries the token and entries expire.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const getFileDiffMeta = vi.fn();
vi.mock("../api", () => ({ getFileDiffMeta: (...a: unknown[]) => getFileDiffMeta(...a) }));

const { fetchFileDiffMetaOnce, __resetFileDiffMetaCache } = await import(
  "../views/diffViewers/computeTierUi"
);

const meta = (headSha: string) => ({ handlerId: "gltf-scene", headSha });

beforeEach(() => {
  __resetFileDiffMetaCache();
  getFileDiffMeta.mockReset();
  getFileDiffMeta.mockImplementation(async () => meta("b".repeat(40)));
});

afterEach(() => vi.useRealTimers());

const fetchFor = (token: string | null) =>
  fetchFileDiffMetaOnce(token, "alice", "scene", "model.gltf", "main");

describe("fetchFileDiffMetaOnce", () => {
  it("shares one request between the pill and the viewer", async () => {
    const [a, b] = await Promise.all([fetchFor("tok"), fetchFor("tok")]);
    expect(a).toBe(b);
    expect(getFileDiffMeta).toHaveBeenCalledTimes(1);
  });

  // Regression: without the token in the key, a logout/login inside one SPA
  // session replayed the previous principal's blob SHAs and sizes.
  it("does not serve one principal's answer to another", async () => {
    await fetchFor("alice-token");
    await fetchFor("bob-token");
    await fetchFor(null);
    expect(getFileDiffMeta).toHaveBeenCalledTimes(3);
  });

  // Regression: a PR file view keys on the head BRANCH, which moves.
  it("expires, so a moved branch is not answered from a stale entry", async () => {
    vi.useFakeTimers();
    await fetchFor("tok");
    vi.advanceTimersByTime(59_000);
    await fetchFor("tok");
    expect(getFileDiffMeta).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await fetchFor("tok");
    expect(getFileDiffMeta).toHaveBeenCalledTimes(2);
  });

  it("does not strand a rejection — a later mount retries", async () => {
    getFileDiffMeta.mockRejectedValueOnce(new Error("boom"));
    await expect(fetchFor("tok")).rejects.toThrow("boom");
    await expect(fetchFor("tok")).resolves.toBeDefined();
    expect(getFileDiffMeta).toHaveBeenCalledTimes(2);
  });

  it("stays bounded as a long session browses many files", async () => {
    for (let i = 0; i < 500; i++) {
      await fetchFileDiffMetaOnce("tok", "alice", "scene", `model${i}.gltf`, "main");
    }
    // The oldest entries were evicted, so re-asking for one costs a request.
    await fetchFileDiffMetaOnce("tok", "alice", "scene", "model0.gltf", "main");
    expect(getFileDiffMeta).toHaveBeenCalledTimes(501);
  });
});
