/**
 * End-to-end text merge pipeline tests.
 *
 * These verify the full chain:
 *   comparePlainTextSnapshots → groupPlainTextHunks → materializePlainTextMerge
 *
 * The scenarios mirror GitHub's merge/conflict behaviour:
 *   - Non-overlapping edits → hunk per region, both sides reconcilable
 *   - Picking "theirs" for every hunk → result equals the incoming text
 *   - Picking "ours" for every hunk   → result equals the base text
 *   - Mixed picks                      → precise line-level control
 */

import { describe, it, expect } from "vitest";
import { comparePlainTextSnapshots } from "../handlers/plain-text/compare.js";
import { groupPlainTextHunks, materializePlainTextMerge } from "../merge/text-hunks.js";
import type { TextHunkSide } from "../merge/text-hunks.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pipeline(baseText: string, incomingText: string) {
  const diff = comparePlainTextSnapshots("base", "incoming", baseText, incomingText);
  const hunks = groupPlainTextHunks(diff.lines);
  return { diff, hunks };
}

function allSides(hunks: ReturnType<typeof groupPlainTextHunks>, side: TextHunkSide) {
  return Object.fromEntries(hunks.map((h) => [h.id, side]));
}

function materialize(
  baseText: string,
  incomingText: string,
  sideMap?: Record<string, TextHunkSide>,
) {
  const { diff, hunks } = pipeline(baseText, incomingText);
  return materializePlainTextMerge(diff.lines, sideMap ?? allSides(hunks, "incoming"));
}

// ─── Invariants ──────────────────────────────────────────────────────────────

describe("GitHub-like merge invariants", () => {
  const BASE = "alpha\nbeta\ngamma\ndelta";
  const INCOMING = "alpha\nBETA\ngamma\nDELTA";

  it("picking 'theirs' for every hunk yields the incoming text", () => {
    const { diff, hunks } = pipeline(BASE, INCOMING);
    const result = materializePlainTextMerge(diff.lines, allSides(hunks, "incoming"));
    expect(result).toBe(INCOMING);
  });

  it("picking 'ours' for every hunk yields the base text", () => {
    const { diff, hunks } = pipeline(BASE, INCOMING);
    const result = materializePlainTextMerge(diff.lines, allSides(hunks, "base"));
    expect(result).toBe(BASE);
  });

  it("picking 'theirs' everywhere when there are no changes also yields the base (no hunks)", () => {
    const { diff, hunks } = pipeline(BASE, BASE);
    expect(hunks).toHaveLength(0);
    const result = materializePlainTextMerge(diff.lines, {});
    expect(result).toBe(BASE);
  });

  it("picking 'ours' when incoming only appends yields the base text", () => {
    const incoming = BASE + "\nappended line";
    const { diff, hunks } = pipeline(BASE, incoming);
    expect(hunks).toHaveLength(1);
    const result = materializePlainTextMerge(diff.lines, allSides(hunks, "base"));
    expect(result).toBe(BASE);
  });

  it("picking 'theirs' when incoming only appends yields the incoming text", () => {
    const incoming = BASE + "\nappended line";
    const result = materialize(BASE, incoming);
    expect(result).toBe(incoming);
  });
});

// ─── Conflict regions ────────────────────────────────────────────────────────

describe("conflict region isolation", () => {
  it("independent edits in different sections → one hunk per section", () => {
    const base = "intro\n---\nbody\n---\noutro";
    // Incoming changes both intro and outro
    const incoming = "INTRO\n---\nbody\n---\nOUTRO";
    const { hunks } = pipeline(base, incoming);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.baseLines).toEqual(["intro"]);
    expect(hunks[0]!.incomingLines).toEqual(["INTRO"]);
    expect(hunks[1]!.baseLines).toEqual(["outro"]);
    expect(hunks[1]!.incomingLines).toEqual(["OUTRO"]);
  });

  it("mixed resolution: keep base intro, take incoming outro", () => {
    const base = "intro\n---\nbody\n---\noutro";
    const incoming = "INTRO\n---\nbody\n---\nOUTRO";
    const { diff, hunks } = pipeline(base, incoming);
    const sides: Record<string, TextHunkSide> = {
      [hunks[0]!.id]: "base",
      [hunks[1]!.id]: "incoming",
    };
    const result = materializePlainTextMerge(diff.lines, sides);
    expect(result).toBe("intro\n---\nbody\n---\nOUTRO");
  });

  it("mixed resolution: take incoming intro, keep base outro", () => {
    const base = "intro\n---\nbody\n---\noutro";
    const incoming = "INTRO\n---\nbody\n---\nOUTRO";
    const { diff, hunks } = pipeline(base, incoming);
    const sides: Record<string, TextHunkSide> = {
      [hunks[0]!.id]: "incoming",
      [hunks[1]!.id]: "base",
    };
    const result = materializePlainTextMerge(diff.lines, sides);
    expect(result).toBe("INTRO\n---\nbody\n---\noutro");
  });

  it("picking ours when both sections conflict → full base restored", () => {
    const base = "a\nshared\nb";
    const incoming = "A\nshared\nB";
    const result = materialize(base, incoming, allSides(pipeline(base, incoming).hunks, "base"));
    expect(result).toBe(base);
  });
});

// ─── Realistic file-level scenarios ──────────────────────────────────────────

describe("realistic merge scenarios", () => {
  it("branch adds a function at the end → pick theirs → function included", () => {
    const base = "function greet() {\n  return 'hello';\n}";
    const incoming = base + "\n\nfunction farewell() {\n  return 'bye';\n}";
    const result = materialize(base, incoming);
    expect(result).toContain("farewell");
    expect(result).toContain("greet");
  });

  it("branch removes a line → pick theirs → line absent from result", () => {
    const base = "keep\nremove-me\nkeep";
    const incoming = "keep\nkeep";
    const result = materialize(base, incoming);
    expect(result).toBe("keep\nkeep");
    expect(result).not.toContain("remove-me");
  });

  it("branch replaces a line → pick ours → original line preserved", () => {
    const base = "line1\noriginal\nline3";
    const incoming = "line1\nreplaced\nline3";
    const { diff, hunks } = pipeline(base, incoming);
    const result = materializePlainTextMerge(diff.lines, allSides(hunks, "base"));
    expect(result).toBe(base);
    expect(result).toContain("original");
  });

  it("branch replaces a line → pick theirs → replacement present", () => {
    const base = "line1\noriginal\nline3";
    const incoming = "line1\nreplaced\nline3";
    const result = materialize(base, incoming);
    expect(result).toBe(incoming);
  });

  it("blank lines are preserved in unchanged context", () => {
    const base = "a\n\nb\n\nc";
    const incoming = "a\n\nB\n\nc";
    const result = materialize(base, incoming);
    expect(result).toBe(incoming);
  });

  it("whole-file replacement → single hunk covering all lines", () => {
    const base = "old line 1\nold line 2\nold line 3";
    const incoming = "new line 1\nnew line 2\nnew line 3";
    const { hunks } = pipeline(base, incoming);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.baseLines).toHaveLength(3);
    expect(hunks[0]!.incomingLines).toHaveLength(3);
  });

  it("adding multiple lines in a block → one hunk, all incoming lines present in theirs", () => {
    const base = "start\nend";
    const incoming = "start\nmiddle1\nmiddle2\nmiddle3\nend";
    const result = materialize(base, incoming);
    expect(result).toBe(incoming);
  });

  it("removing multiple lines in a block → one hunk, all lines gone in theirs", () => {
    const base = "start\nmiddle1\nmiddle2\nmiddle3\nend";
    const incoming = "start\nend";
    const result = materialize(base, incoming);
    expect(result).toBe(incoming);
  });
});

// ─── Hunk count and shape verification ───────────────────────────────────────

describe("hunk count matches change regions", () => {
  it("one contiguous changed block → one hunk", () => {
    const { hunks } = pipeline("a\nb\nc", "a\nX\nc");
    expect(hunks).toHaveLength(1);
  });

  it("two separate changed blocks → two hunks", () => {
    const { hunks } = pipeline("a\nshared\nb", "A\nshared\nB");
    expect(hunks).toHaveLength(2);
  });

  it("three separate changed blocks → three hunks", () => {
    const base = "a\nctx\nb\nctx\nc";
    const incoming = "A\nctx\nB\nctx\nC";
    const { hunks } = pipeline(base, incoming);
    expect(hunks).toHaveLength(3);
  });

  it("unchanged file → no hunks", () => {
    const text = "same\ncontent\nhere";
    const { hunks } = pipeline(text, text);
    expect(hunks).toHaveLength(0);
  });
});

// ─── Diff summary accuracy ────────────────────────────────────────────────────

describe("diff summary accurately counts changes", () => {
  it("purely additive incoming → zero removed lines", () => {
    const base = "a\nb";
    const incoming = "a\nb\nc\nd";
    const { diff } = pipeline(base, incoming);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.added).toBe(2);
    expect(diff.summary.unchanged).toBe(2);
  });

  it("purely subtractive incoming → zero added lines", () => {
    const base = "a\nb\nc";
    const incoming = "a";
    const { diff } = pipeline(base, incoming);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(2);
    expect(diff.summary.unchanged).toBe(1);
  });

  it("summary totals equal lines array length", () => {
    const base = "one\ntwo\nthree\nfour";
    const incoming = "one\nTWO\nthree\nFOUR\nfive";
    const { diff } = pipeline(base, incoming);
    const { added, removed, unchanged } = diff.summary;
    expect(added + removed + unchanged).toBe(diff.lines.length);
  });
});
