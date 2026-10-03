import { describe, it, expect } from "vitest";
import { summarizeReleases } from "../pages/repo/RepoSidebar";
import type { Release } from "../types";

const release = (tagName: string, flags: Partial<Pick<Release, "isDraft" | "isPrerelease">> = {}) =>
  ({ tagName, name: tagName, isDraft: false, isPrerelease: false, ...flags }) as Release;

// The sidebar's Releases section (#208) follows GitHub: drafts are not
// releases yet, and "Latest" is the newest published full release.
describe("summarizeReleases", () => {
  it("leaves drafts out of the count", () => {
    const { published } = summarizeReleases([release("v3", { isDraft: true }), release("v2"), release("v1")]);
    expect(published.map((r) => r.tagName)).toEqual(["v2", "v1"]);
  });

  it("never calls a prerelease or a draft Latest", () => {
    const { latest } = summarizeReleases([
      release("v3", { isDraft: true }),
      release("v3-rc1", { isPrerelease: true }),
      release("v2"),
    ]);
    expect(latest?.tagName).toBe("v2");
  });

  it("has no Latest when only prereleases are published", () => {
    const { published, latest } = summarizeReleases([release("v1-rc2", { isPrerelease: true }), release("v1-rc1", { isPrerelease: true })]);
    expect(published).toHaveLength(2);
    expect(latest).toBeNull();
  });

  it("is empty for no releases", () => {
    expect(summarizeReleases([])).toEqual({ published: [], latest: null });
  });
});
