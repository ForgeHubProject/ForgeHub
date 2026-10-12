/**
 * The Commits tab's list as a URL (#224): a file's or folder's history is the
 * list with `?path=`, on `?ref=`, paged with `?page=`, and links leave out what
 * is already the default.
 */
import { describe, it, expect } from "vitest";
import { COMMITS_PER_PAGE, commitListQuery, commitListUrl } from "../pages/repo/commitHistory";
import { historyUrl } from "../pages/repo/LatestCommitBar";

const q = (s: string) => commitListQuery(new URLSearchParams(s), "main");

describe("commitListQuery", () => {
  it("defaults to the repo page's branch, no path, page 1", () => {
    expect(q("")).toEqual({ ref: "main", path: null, page: 1 });
  });

  it("reads ref, path and page, trimming slashes from the path", () => {
    expect(q("ref=feature%2Fdesk&path=%2Fdocs%2Fsetup.md%2F&page=3")).toEqual({ ref: "feature/desk", path: "docs/setup.md", page: 3 });
  });

  it("treats a missing, zero or junk page as page 1", () => {
    expect(q("page=0").page).toBe(1);
    expect(q("page=-4").page).toBe(1);
    expect(q("page=abc").page).toBe(1);
  });
});

describe("commitListUrl", () => {
  it("leaves out the defaults", () => {
    expect(commitListUrl("/acme/tools", { ref: "main", path: null, page: 1 }, "main")).toBe("/acme/tools/commits");
  });

  it("keeps a non-default ref, the path and a later page, and round-trips", () => {
    const query = { ref: "feature/desk", path: "docs/setup.md", page: 2 };
    const url = commitListUrl("/acme/tools", query, "main");
    expect(url).toBe("/acme/tools/commits?ref=feature%2Fdesk&path=docs%2Fsetup.md&page=2");
    expect(commitListQuery(new URL(url, "http://x").searchParams, "main")).toEqual(query);
  });

  it("pages are a fixed size, as before paging existed", () => {
    expect(COMMITS_PER_PAGE).toBe(50);
  });
});

describe("historyUrl", () => {
  it("is the Commits tab filtered to the path, on the ref", () => {
    expect(historyUrl("/acme/tools", "main", "src/a b.ts")).toBe("/acme/tools/commits?ref=main&path=src%2Fa+b.ts");
    expect(commitListQuery(new URL(historyUrl("/acme/tools", "dev", "src/a b.ts"), "http://x").searchParams, "main"))
      .toEqual({ ref: "dev", path: "src/a b.ts", page: 1 });
  });
});
