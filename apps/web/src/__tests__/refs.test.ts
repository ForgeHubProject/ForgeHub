import { describe, it, expect } from "vitest";
import { blobFromSplat, refFromSplat, refLabel } from "../pages/repo/refs";
import type { BranchInfo } from "../types";

const branch = (name: string) => ({ name, sha: "", subject: "", date: "", isDefault: false }) as BranchInfo;
const branches = [branch("main"), branch("feature/desk-shelf"), branch("feature"), branch("abc1234")];
const sha = "1b94af7c0ffee0000000000000000000000000ab".slice(0, 40);

describe("refFromSplat", () => {
  it("finds the longest branch the splat starts with, slashes and all", () => {
    expect(refFromSplat("tree/main", branches)).toBe("main");
    expect(refFromSplat("tree/feature/desk-shelf/furniture", branches)).toBe("feature/desk-shelf");
    expect(refFromSplat("tree/feature/other", branches)).toBe("feature");
  });

  // "Browse files" on a commit page (#215).
  it("takes a commit hash when no branch matches, full or short", () => {
    expect(refFromSplat(`tree/${sha}`, branches)).toBe(sha);
    expect(refFromSplat(`tree/${sha}/parts`, branches)).toBe(sha);
    expect(refFromSplat("tree/1b94af7/parts", branches)).toBe("1b94af7");
  });

  it("prefers a branch named like a hash, and rejects what is neither", () => {
    expect(refFromSplat("tree/abc1234", branches)).toBe("abc1234");
    expect(refFromSplat("tree/not-a-branch", branches)).toBeNull();
    expect(refFromSplat("commits/main", branches)).toBeNull();
  });

  // Opening a file by URL on a slashed branch read it at "feature".
  it("resolves blob splats by the same rule", () => {
    expect(refFromSplat("blob/main/README.md", branches)).toBe("main");
    expect(refFromSplat("blob/feature/desk-shelf/drawer/trap.obj", branches)).toBe("feature/desk-shelf");
    expect(refFromSplat("blob/1b94af7/parts/leg.obj", branches)).toBe("1b94af7");
    expect(refFromSplat("blob/abc1234/README.md", branches)).toBe("abc1234");
    expect(refFromSplat("blob/v1.0/README.md", branches)).toBeNull();
  });
});

describe("blobFromSplat", () => {
  it("splits a slashed branch from the file path", () => {
    expect(blobFromSplat("blob/feature/desk-shelf/trap.obj", branches)).toEqual({ ref: "feature/desk-shelf", path: "trap.obj" });
    expect(blobFromSplat("blob/feature/other/trap.obj", branches)).toEqual({ ref: "feature", path: "other/trap.obj" });
  });

  it("keeps a nested path whole", () => {
    expect(blobFromSplat("blob/feature/desk-shelf/drawer/rails/left.obj", branches))
      .toEqual({ ref: "feature/desk-shelf", path: "drawer/rails/left.obj" });
    expect(blobFromSplat("blob/main/a/b/c.txt", branches)).toEqual({ ref: "main", path: "a/b/c.txt" });
  });

  it("takes a commit hash, full or short, and prefers a branch named like one", () => {
    expect(blobFromSplat(`blob/${sha}/parts/leg.obj`, branches)).toEqual({ ref: sha, path: "parts/leg.obj" });
    expect(blobFromSplat("blob/1b94af7/leg.obj", branches)).toEqual({ ref: "1b94af7", path: "leg.obj" });
    expect(blobFromSplat("blob/abc1234/leg.obj", branches)).toEqual({ ref: "abc1234", path: "leg.obj" });
    const hashy = [...branches, branch("abc1234/fix")];
    expect(blobFromSplat("blob/abc1234/fix/leg.obj", hashy)).toEqual({ ref: "abc1234/fix", path: "leg.obj" });
  });

  it("leaves an unknown ref to the server as the first segment", () => {
    expect(blobFromSplat("blob/v1.0/README.md", branches)).toEqual({ ref: "v1.0", path: "README.md" });
    expect(blobFromSplat("blob/release/2.0/README.md", branches)).toEqual({ ref: "release", path: "2.0/README.md" });
  });

  it("is null without a path or outside blob mode", () => {
    expect(blobFromSplat("blob/feature/desk-shelf", branches)).toBeNull();
    expect(blobFromSplat("blob/main/", branches)).toBeNull();
    expect(blobFromSplat("blob/v1.0", branches)).toBeNull();
    expect(blobFromSplat("blob//README.md", branches)).toBeNull();
    expect(blobFromSplat("tree/main/README.md", branches)).toBeNull();
  });
});

describe("refLabel", () => {
  it("shortens a full commit hash and leaves names alone", () => {
    expect(refLabel(sha)).toBe("1b94af7");
    expect(refLabel("feature/desk-shelf")).toBe("feature/desk-shelf");
  });
});
