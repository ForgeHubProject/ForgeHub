import { describe, it, expect } from "vitest";
import { contextLines, hunkGaps, splitRows } from "../pages/repo/pulls/diffLayout";
import type { DiffLine } from "../types";

const ctx = (o: number, n: number, c = `l${n}`): DiffLine => ({ type: "context", content: c, oldLineNo: o, newLineNo: n });
const add = (n: number, c = `+${n}`): DiffLine => ({ type: "add", content: c, oldLineNo: null, newLineNo: n });
const del = (o: number, c = `-${o}`): DiffLine => ({ type: "remove", content: c, oldLineNo: o, newLineNo: null });

describe("splitRows", () => {
  it("pairs removals with the additions after them, and keeps context on both sides", () => {
    const rows = splitRows([ctx(1, 1), del(2), del(3), add(2), ctx(4, 3), add(4)]);
    expect(rows.map((r) => [r.left?.content ?? null, r.right?.content ?? null])).toEqual([
      ["l1", "l1"], ["-2", "+2"], ["-3", null], ["l3", "l3"], [null, "+4"],
    ]);
  });
});

describe("hunkGaps", () => {
  it("finds the hidden lines above, between and below hunks, with the old-number offset", () => {
    // A 20-line file: a hunk at new 5-7 that adds a line, another at new 15-16 that removes one.
    const hunks = [
      { lines: [ctx(5, 5), add(6), ctx(6, 7)] },
      { lines: [ctx(14, 15), del(15), ctx(16, 16)] },
    ];
    expect(hunkGaps(hunks, 20)).toEqual([
      { before: 0, from: 1, to: 4, offset: 0 },
      { before: 1, from: 8, to: 14, offset: 1 },
      { before: 2, from: 17, to: 20, offset: 0 },
    ]);
  });

  it("leaves out empty gaps", () => {
    expect(hunkGaps([{ lines: [ctx(1, 1), add(2)] }], 2)).toEqual([]);
  });
});

describe("contextLines", () => {
  it("numbers revealed lines on both sides", () => {
    expect(contextLines(["a", "b", "c", "d"], 2, 3, 1)).toEqual([
      { type: "context", content: "b", oldLineNo: 1, newLineNo: 2 },
      { type: "context", content: "c", oldLineNo: 2, newLineNo: 3 },
    ]);
  });
});
