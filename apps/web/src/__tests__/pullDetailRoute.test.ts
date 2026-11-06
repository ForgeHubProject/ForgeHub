/**
 * A PR's four tabs are four URLs (#252): `pulls/:number` (Conversation) and
 * `pulls/:number/commits`, `/checks` and `/files` (Files changed, which
 * RepoPage widens to the window).
 */
import { describe, it, expect } from "vitest";
import { PULL_DETAIL } from "../pages/repo/RepoPullsTab";

describe("PULL_DETAIL", () => {
  it("reads the PR number, and the tab from the last segment", () => {
    expect(PULL_DETAIL.exec("pulls/12")?.slice(1)).toEqual(["12", undefined]);
    expect(PULL_DETAIL.exec("pulls/12/commits")?.slice(1)).toEqual(["12", "commits"]);
    expect(PULL_DETAIL.exec("pulls/12/checks")?.slice(1)).toEqual(["12", "checks"]);
    expect(PULL_DETAIL.exec("pulls/12/files")?.slice(1)).toEqual(["12", "files"]);
  });

  it("leaves every other pulls page alone", () => {
    for (const splat of ["pulls", "pulls/new", "pulls/12/", "pulls/12/filesx", "pulls/12/conversation", "pulls/x/files"]) {
      expect(PULL_DETAIL.exec(splat)).toBeNull();
    }
  });
});
