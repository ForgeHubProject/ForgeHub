import { describe, it, expect } from "vitest";
import type { TextDiffLineRow } from "../types";
import {
  plainTextDiffHasOld,
  plainTextDiffHasNew,
  plainTextFromBase,
  plainTextFromTarget,
} from "../lib/plainTextDiffView";

function row(type: TextDiffLineRow["type"], content: string): TextDiffLineRow {
  return { type, content, oldLine: null, newLine: null };
}

const added = (c: string) => row("added", c);
const removed = (c: string) => row("removed", c);
const unchanged = (c: string) => row("unchanged", c);

describe("plainTextDiffHasOld", () => {
  it("returns true when there are removed lines", () => {
    expect(plainTextDiffHasOld([removed("old line")])).toBe(true);
  });

  it("returns true when there are unchanged lines", () => {
    expect(plainTextDiffHasOld([unchanged("same")])).toBe(true);
  });

  it("returns false when only added lines exist", () => {
    expect(plainTextDiffHasOld([added("new line")])).toBe(false);
  });

  it("returns false for an empty diff", () => {
    expect(plainTextDiffHasOld([])).toBe(false);
  });

  it("returns true for a mixed diff", () => {
    expect(plainTextDiffHasOld([added("a"), unchanged("b"), added("c")])).toBe(true);
  });
});

describe("plainTextDiffHasNew", () => {
  it("returns true when there are added lines", () => {
    expect(plainTextDiffHasNew([added("new line")])).toBe(true);
  });

  it("returns true when there are unchanged lines", () => {
    expect(plainTextDiffHasNew([unchanged("same")])).toBe(true);
  });

  it("returns false when only removed lines exist", () => {
    expect(plainTextDiffHasNew([removed("old line")])).toBe(false);
  });

  it("returns false for an empty diff", () => {
    expect(plainTextDiffHasNew([])).toBe(false);
  });
});

describe("plainTextFromBase", () => {
  it("returns only removed and unchanged lines joined by newlines", () => {
    const lines = [unchanged("keep"), removed("old"), added("new"), unchanged("end")];
    expect(plainTextFromBase(lines)).toBe("keep\nold\nend");
  });

  it("excludes added lines entirely", () => {
    const lines = [added("x"), added("y")];
    expect(plainTextFromBase(lines)).toBe("");
  });

  it("returns full text when no changes (all unchanged)", () => {
    const lines = [unchanged("a"), unchanged("b"), unchanged("c")];
    expect(plainTextFromBase(lines)).toBe("a\nb\nc");
  });

  it("returns empty string for an empty diff", () => {
    expect(plainTextFromBase([])).toBe("");
  });
});

describe("plainTextFromTarget", () => {
  it("returns only added and unchanged lines joined by newlines", () => {
    const lines = [unchanged("keep"), removed("old"), added("new"), unchanged("end")];
    expect(plainTextFromTarget(lines)).toBe("keep\nnew\nend");
  });

  it("excludes removed lines entirely", () => {
    const lines = [removed("x"), removed("y")];
    expect(plainTextFromTarget(lines)).toBe("");
  });

  it("returns full text when no changes (all unchanged)", () => {
    const lines = [unchanged("a"), unchanged("b"), unchanged("c")];
    expect(plainTextFromTarget(lines)).toBe("a\nb\nc");
  });

  it("base and target together reconstruct both sides of a diff", () => {
    const lines = [unchanged("header"), removed("base-only"), added("target-only"), unchanged("footer")];
    expect(plainTextFromBase(lines)).toBe("header\nbase-only\nfooter");
    expect(plainTextFromTarget(lines)).toBe("header\ntarget-only\nfooter");
  });
});
