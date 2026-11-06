import { describe, it, expect } from "vitest";
import { lineDiff, patchBranchName } from "../pages/repo/FileEditor";

describe("lineDiff", () => {
  it("keeps common lines and marks the rest", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("says nothing changed for equal files", () => {
    expect(lineDiff(["a", "b"], ["a", "b"]).every((r) => r.kind === "same")).toBe(true);
  });
});

describe("patchBranchName", () => {
  it("takes the first free <user>-patch-N", () => {
    expect(patchBranchName("ada", [{ name: "main" }])).toBe("ada-patch-1");
    expect(patchBranchName("ada", [{ name: "ada-patch-1" }, { name: "ada-patch-2" }])).toBe("ada-patch-3");
  });
});
