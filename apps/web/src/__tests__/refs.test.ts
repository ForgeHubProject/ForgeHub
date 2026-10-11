import { describe, it, expect } from "vitest";
import { refFromSplat, refLabel } from "../pages/repo/refs";
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
    expect(refFromSplat("blob/main/README.md", branches)).toBeNull();
  });
});

describe("refLabel", () => {
  it("shortens a full commit hash and leaves names alone", () => {
    expect(refLabel(sha)).toBe("1b94af7");
    expect(refLabel("feature/desk-shelf")).toBe("feature/desk-shelf");
  });
});
