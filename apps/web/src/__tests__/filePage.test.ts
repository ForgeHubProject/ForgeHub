/**
 * The file page's pieces that are pure logic (#223): Go to file's fuzzy match,
 * and the tree pane's ordering and "open down to the current file".
 */
import { describe, it, expect } from "vitest";
import { matchPaths, scorePath } from "../lib/fuzzyPath";
import { ancestorDirs, sortEntries } from "../pages/repo/FileTreePane";
import type { TreeEntry } from "../types";

const PATHS = [
  "README.md",
  "apps/web/src/components/BlobViewer.tsx",
  "apps/web/src/pages/repo/RepoCodeTab.tsx",
  "apps/api/src/routes/repo-paths.ts",
  "apps/api/src/repo-paths.ts",
  "models/desk v2.glb",
  "docs/blob-viewer-notes.md",
];

describe("scorePath", () => {
  it("matches the query's characters in order, case-insensitively, and nothing else", () => {
    expect(scorePath("apps/web/src/components/BlobViewer.tsx", "blobv")).not.toBeNull();
    expect(scorePath("apps/web/src/components/BlobViewer.tsx", "BLOBV")).not.toBeNull();
    expect(scorePath("README.md", "mdr")).toBeNull(); // out of order
    expect(scorePath("README.md", "xyz")).toBeNull();
  });

  it("reports which characters matched, for highlighting", () => {
    // "rme": R, then the consecutive "ME"; a word-start jump to the second m would leave no e.
    expect(scorePath("README.md", "rme")?.hits).toEqual([0, 4, 5]);
  });

  it("an empty query matches everything with no hits", () => {
    expect(scorePath("README.md", "  ")).toEqual({ path: "README.md", score: 0, hits: [] });
  });
});

describe("matchPaths", () => {
  it("ranks a file name match above the same letters scattered through folders", () => {
    expect(matchPaths(PATHS, "blobviewer")[0]!.path).toBe("apps/web/src/components/BlobViewer.tsx");
  });

  it("prefers word starts: 'rct' finds RepoCodeTab first", () => {
    expect(matchPaths(PATHS, "rct")[0]!.path).toBe("apps/web/src/pages/repo/RepoCodeTab.tsx");
  });

  it("breaks ties towards the shorter path", () => {
    const [first, second] = matchPaths(PATHS, "repo-paths");
    expect(first!.path).toBe("apps/api/src/repo-paths.ts");
    expect(second!.path).toBe("apps/api/src/routes/repo-paths.ts");
  });

  it("ignores spaces in the query, and limits the results", () => {
    expect(matchPaths(PATHS, "desk v2")[0]!.path).toBe("models/desk v2.glb");
    expect(matchPaths(PATHS, "s", 2)).toHaveLength(2);
  });
});

describe("file tree pane helpers", () => {
  it("opens every folder above the current file", () => {
    expect(ancestorDirs("apps/web/src/main.tsx")).toEqual(["apps", "apps/web", "apps/web/src"]);
    expect(ancestorDirs("README.md")).toEqual([]);
  });

  it("lists folders first, then files, each alphabetically", () => {
    const e = (name: string, type: "tree" | "blob"): TreeEntry => ({ name, type, path: name, mode: "", sha: "" });
    expect(sortEntries([e("b.txt", "blob"), e("src", "tree"), e("a.txt", "blob"), e("docs", "tree")]).map((x) => x.name))
      .toEqual(["docs", "src", "a.txt", "b.txt"]);
  });
});
