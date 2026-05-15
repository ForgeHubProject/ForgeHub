import { describe, it, expect } from "vitest";
import { groupPlainTextHunks, materializePlainTextMerge } from "../merge/text-hunks.js";
import type { TextDiffLine } from "../merge/text-hunks.js";

function lines(...defs: Array<[TextDiffLine["type"], string]>): TextDiffLine[] {
  return defs.map(([type, content]) => ({ type, content }));
}

describe("groupPlainTextHunks", () => {
  it("no diff lines → no hunks", () => {
    expect(groupPlainTextHunks([])).toHaveLength(0);
  });

  it("only unchanged lines → no hunks", () => {
    const ls = lines(["unchanged", "a"], ["unchanged", "b"]);
    expect(groupPlainTextHunks(ls)).toHaveLength(0);
  });

  it("single removed line → one hunk with baseLines", () => {
    const ls = lines(["removed", "old"]);
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toEqual(["old"]);
    expect(hunks[0]!.incomingLines).toEqual([]);
  });

  it("single added line → one hunk with incomingLines", () => {
    const ls = lines(["added", "new"]);
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toEqual([]);
    expect(hunks[0]!.incomingLines).toEqual(["new"]);
  });

  it("removed then added in sequence → one hunk", () => {
    const ls = lines(["removed", "old"], ["added", "new"]);
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toEqual(["old"]);
    expect(hunks[0]!.incomingLines).toEqual(["new"]);
  });

  it("two separate changes separated by unchanged → two hunks", () => {
    const ls = lines(
      ["removed", "a"],
      ["unchanged", "ctx"],
      ["added", "b"],
    );
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.baseLines).toEqual(["a"]);
    expect(hunks[1]!.incomingLines).toEqual(["b"]);
  });

  it("hunk IDs are unique and stable", () => {
    const ls = lines(["removed", "a"], ["unchanged", "x"], ["added", "b"]);
    const hunks = groupPlainTextHunks(ls);
    const ids = hunks.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("consecutive removed/added lines collapse into single hunk", () => {
    const ls = lines(["removed", "r1"], ["removed", "r2"], ["added", "a1"], ["added", "a2"]);
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toEqual(["r1", "r2"]);
    expect(hunks[0]!.incomingLines).toEqual(["a1", "a2"]);
  });
});

describe("materializePlainTextMerge", () => {
  it("all unchanged, no hunks → returns joined unchanged lines", () => {
    const ls = lines(["unchanged", "a"], ["unchanged", "b"]);
    expect(materializePlainTextMerge(ls, {})).toBe("a\nb");
  });

  it("default side=incoming: picks incoming lines for changed hunks", () => {
    const ls = lines(["removed", "base line"], ["added", "incoming line"]);
    expect(materializePlainTextMerge(ls, {})).toBe("incoming line");
  });

  it("explicit side=base: picks base lines for changed hunks", () => {
    const ls = lines(["removed", "base line"], ["added", "incoming line"]);
    const hunks = groupPlainTextHunks(ls);
    const sides: Record<string, "base" | "incoming"> = { [hunks[0]!.id]: "base" };
    expect(materializePlainTextMerge(ls, sides)).toBe("base line");
  });

  it("mixed: different sides per hunk", () => {
    const ls = lines(
      ["removed", "rm-1"],
      ["added", "add-1"],
      ["unchanged", "ctx"],
      ["removed", "rm-2"],
      ["added", "add-2"],
    );
    const hunks = groupPlainTextHunks(ls);
    expect(hunks).toHaveLength(2);
    const sides: Record<string, "base" | "incoming"> = {
      [hunks[0]!.id]: "base",
      [hunks[1]!.id]: "incoming",
    };
    expect(materializePlainTextMerge(ls, sides)).toBe("rm-1\nctx\nadd-2");
  });

  it("unchanged context is always included regardless of side picks", () => {
    const ls = lines(["unchanged", "header"], ["removed", "old"], ["added", "new"], ["unchanged", "footer"]);
    const result = materializePlainTextMerge(ls, {});
    expect(result.startsWith("header")).toBe(true);
    expect(result.endsWith("footer")).toBe(true);
  });

  it("picking base side with no base lines → drops that section", () => {
    const ls = lines(["added", "incoming only"]);
    const hunks = groupPlainTextHunks(ls);
    const sides: Record<string, "base" | "incoming"> = { [hunks[0]!.id]: "base" };
    expect(materializePlainTextMerge(ls, sides)).toBe("");
  });

  it("picking incoming side with no incoming lines → drops that section", () => {
    const ls = lines(["removed", "base only"]);
    expect(materializePlainTextMerge(ls, {})).toBe("");
  });

  it("multi-line hunks are fully included", () => {
    const ls = lines(["removed", "r1"], ["removed", "r2"], ["added", "a1"], ["added", "a2"]);
    const result = materializePlainTextMerge(ls, {});
    expect(result).toBe("a1\na2");
  });

  it("defaultSide param can switch default to base", () => {
    const ls = lines(["removed", "base line"], ["added", "incoming line"]);
    expect(materializePlainTextMerge(ls, {}, "base")).toBe("base line");
  });
});
