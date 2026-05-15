/**
 * Tests for groupPlainTextHunks, defaultHunkSides, and materializePlainTextMerge.
 *
 * Important: the frontend uses 1-based hunk IDs (h1, h2, …) unlike the backend.
 */

import { describe, it, expect } from "vitest";
import type { TextDiffLineRow } from "../types";
import {
  groupPlainTextHunks,
  defaultHunkSides,
  materializePlainTextMerge,
} from "../lib/textMergeHunks";

function row(type: TextDiffLineRow["type"], content: string): TextDiffLineRow {
  return { type, content, oldLine: null, newLine: null };
}

const added = (c: string) => row("added", c);
const removed = (c: string) => row("removed", c);
const unchanged = (c: string) => row("unchanged", c);

// ─── groupPlainTextHunks ──────────────────────────────────────────────────────

describe("groupPlainTextHunks", () => {
  it("returns empty array for an all-unchanged diff", () => {
    expect(groupPlainTextHunks([unchanged("a"), unchanged("b")])).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(groupPlainTextHunks([])).toHaveLength(0);
  });

  it("groups one contiguous block of changes into one hunk", () => {
    const lines = [unchanged("ctx"), removed("old"), added("new"), unchanged("ctx")];
    const hunks = groupPlainTextHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.id).toBe("h1");
    expect(hunks[0]!.baseLines).toEqual(["old"]);
    expect(hunks[0]!.incomingLines).toEqual(["new"]);
  });

  it("uses 1-based IDs: first hunk is h1, second is h2", () => {
    const lines = [
      removed("a"), added("A"),
      unchanged("ctx"),
      removed("b"), added("B"),
    ];
    const hunks = groupPlainTextHunks(lines);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.id).toBe("h1");
    expect(hunks[1]!.id).toBe("h2");
  });

  it("pure addition hunk has empty baseLines", () => {
    const lines = [unchanged("before"), added("only-new"), unchanged("after")];
    const [hunk] = groupPlainTextHunks(lines);
    expect(hunk!.baseLines).toHaveLength(0);
    expect(hunk!.incomingLines).toEqual(["only-new"]);
  });

  it("pure deletion hunk has empty incomingLines", () => {
    const lines = [unchanged("before"), removed("only-old"), unchanged("after")];
    const [hunk] = groupPlainTextHunks(lines);
    expect(hunk!.baseLines).toEqual(["only-old"]);
    expect(hunk!.incomingLines).toHaveLength(0);
  });

  it("consecutive remove+add lines without unchanged separator form one hunk", () => {
    const lines = [removed("r1"), removed("r2"), added("a1"), added("a2")];
    const hunks = groupPlainTextHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toEqual(["r1", "r2"]);
    expect(hunks[0]!.incomingLines).toEqual(["a1", "a2"]);
  });
});

// ─── defaultHunkSides ────────────────────────────────────────────────────────

describe("defaultHunkSides", () => {
  it("returns empty object for no hunks", () => {
    expect(defaultHunkSides([], "incoming")).toEqual({});
  });

  it("sets all hunks to the given side", () => {
    const lines = [
      removed("a"), added("A"),
      unchanged("ctx"),
      removed("b"), added("B"),
    ];
    const hunks = groupPlainTextHunks(lines);
    const sides = defaultHunkSides(hunks, "base");
    expect(sides).toEqual({ h1: "base", h2: "base" });
  });

  it("incoming default maps each hunk id to incoming", () => {
    const lines = [removed("x"), added("y")];
    const hunks = groupPlainTextHunks(lines);
    expect(defaultHunkSides(hunks, "incoming")).toEqual({ h1: "incoming" });
  });
});

// ─── materializePlainTextMerge ───────────────────────────────────────────────

describe("materializePlainTextMerge", () => {
  const LINES = [
    unchanged("header"),
    removed("base line"),
    added("incoming line"),
    unchanged("footer"),
  ];

  it("picking incoming for h1 → uses added line", () => {
    const result = materializePlainTextMerge(LINES, { h1: "incoming" });
    expect(result).toBe("header\nincoming line\nfooter");
  });

  it("picking base for h1 → uses removed line", () => {
    const result = materializePlainTextMerge(LINES, { h1: "base" });
    expect(result).toBe("header\nbase line\nfooter");
  });

  it("missing side defaults to incoming", () => {
    const result = materializePlainTextMerge(LINES, {});
    expect(result).toBe("header\nincoming line\nfooter");
  });

  it("unchanged lines always appear regardless of hunk side", () => {
    const result = materializePlainTextMerge(LINES, { h1: "base" });
    expect(result.startsWith("header")).toBe(true);
    expect(result.endsWith("footer")).toBe(true);
  });

  it("pure-addition hunk: base side produces empty for that hunk", () => {
    const lines = [unchanged("ctx"), added("new"), unchanged("end")];
    expect(materializePlainTextMerge(lines, { h1: "base" })).toBe("ctx\nend");
  });

  it("pure-deletion hunk: incoming side produces empty for that hunk", () => {
    const lines = [unchanged("ctx"), removed("old"), unchanged("end")];
    expect(materializePlainTextMerge(lines, { h1: "incoming" })).toBe("ctx\nend");
  });

  it("two hunks can be resolved independently", () => {
    const lines = [
      removed("r1"), added("a1"),
      unchanged("mid"),
      removed("r2"), added("a2"),
    ];
    const result = materializePlainTextMerge(lines, { h1: "base", h2: "incoming" });
    expect(result).toBe("r1\nmid\na2");
  });

  it("all-unchanged diff returns all lines joined", () => {
    const lines = [unchanged("x"), unchanged("y"), unchanged("z")];
    expect(materializePlainTextMerge(lines, {})).toBe("x\ny\nz");
  });
});
