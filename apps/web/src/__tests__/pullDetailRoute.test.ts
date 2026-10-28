/**
 * A PR's two tabs are two URLs: `pulls/:number` (Commits) and
 * `pulls/:number/files` (Files changed), which RepoPage widens to the window.
 */
import { describe, it, expect } from "vitest";
import { PULL_DETAIL } from "../pages/repo/RepoPullsTab";

describe("PULL_DETAIL", () => {
  it("reads the PR number, and Files changed from /files", () => {
    expect(PULL_DETAIL.exec("pulls/12")?.slice(1)).toEqual(["12", undefined]);
    expect(PULL_DETAIL.exec("pulls/12/files")?.slice(1)).toEqual(["12", "/files"]);
  });

  it("leaves every other pulls page alone", () => {
    for (const splat of ["pulls", "pulls/new", "pulls/12/", "pulls/12/filesx", "pulls/12/commits", "pulls/x/files"]) {
      expect(PULL_DETAIL.exec(splat)).toBeNull();
    }
  });
});
