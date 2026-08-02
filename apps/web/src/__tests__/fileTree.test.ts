import { describe, it, expect } from "vitest";
import { buildFileTree, countFiles, fileAnchorId } from "../pages/repo/pulls/fileTree";

const entry = (path: string) => ({ path });

describe("buildFileTree", () => {
  it("nests files under their directories, root files at the top level", () => {
    const tree = buildFileTree([entry("README.md"), entry("src/a.ts"), entry("src/b.ts")]);
    expect(tree.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0].name).toBe("src");
    expect(tree.dirs[0].files.map((f) => f.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("sorts directories before files, each alphabetically", () => {
    const tree = buildFileTree([
      entry("z.txt"), entry("a.txt"),
      entry("beta/x.ts"), entry("alpha/y.ts"), entry("alpha/child/deep.ts"),
    ]);
    expect(tree.dirs.map((d) => d.name)).toEqual(["alpha", "beta"]);
    expect(tree.files.map((f) => f.name)).toEqual(["a.txt", "z.txt"]);
    // alpha has a file, so its child dir is NOT compressed away and sorts first.
    expect(tree.dirs[0].dirs.map((d) => d.name)).toEqual(["child"]);
  });

  it("compresses single-child directory chains into one row (GitHub anatomy)", () => {
    const tree = buildFileTree([entry("src/components/ui/Button.tsx")]);
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0].name).toBe("src/components/ui");
    expect(tree.dirs[0].path).toBe("src/components/ui");
    expect(tree.dirs[0].files.map((f) => f.name)).toEqual(["Button.tsx"]);
  });

  it("does NOT compress a directory that has files of its own", () => {
    const tree = buildFileTree([entry("src/index.ts"), entry("src/ui/Button.tsx")]);
    expect(tree.dirs[0].name).toBe("src");
    expect(tree.dirs[0].files.map((f) => f.name)).toEqual(["index.ts"]);
    expect(tree.dirs[0].dirs[0].name).toBe("ui");
  });

  it("keeps the full entry on each file node", () => {
    const tree = buildFileTree([{ path: "src/a.ts", viewed: true, additions: 3 }]);
    expect(tree.dirs[0].files[0].entry).toEqual({ path: "src/a.ts", viewed: true, additions: 3 });
  });

  it("countFiles totals files across nested directories", () => {
    const tree = buildFileTree([
      entry("src/a.ts"), entry("src/ui/b.tsx"), entry("src/ui/c.tsx"), entry("docs/d.md"),
    ]);
    const src = tree.dirs.find((d) => d.name === "src")!;
    expect(countFiles(src)).toBe(3);
  });

  it("handles an empty list", () => {
    expect(buildFileTree([])).toEqual({ dirs: [], files: [] });
  });
});

describe("fileAnchorId", () => {
  it("is stable and selector-safe for paths with slashes and dots", () => {
    const id = fileAnchorId("src/ui/Button.tsx");
    expect(id).toBe(fileAnchorId("src/ui/Button.tsx"));
    expect(id).toMatch(/^pr-file-[a-zA-Z0-9_-]+$/);
  });

  it("distinguishes different paths", () => {
    expect(fileAnchorId("a/b.ts")).not.toBe(fileAnchorId("a_b.ts"));
  });
});
