import { describe, it, expect } from "vitest";
import { parseDuration, formatDuration } from "../duration.js";

describe("parseDuration (GitLab semantics)", () => {
  const cases: Array<[string, number | null]> = [
    // Single units
    ["30m", 30],
    ["1h", 60],
    ["1d", 8 * 60], // 1d = 8h
    ["1w", 5 * 8 * 60], // 1w = 5d = 40h
    // Combined units
    ["2h30m", 150],
    ["1h30m", 90],
    ["1d4h", 8 * 60 + 4 * 60],
    ["1w5d", 5 * 8 * 60 + 5 * 8 * 60], // 2400 + 2400 = 4800
    // Whitespace between chunks
    ["1d 4h", 8 * 60 + 4 * 60],
    ["  2h   30m ", 150],
    // Case-insensitive
    ["2H30M", 150],
    // Signs (for /spend)
    ["-3h", -180],
    ["-1h30m", -90],
    ["+2h", 120],
    // Zero
    ["0m", 0],
    // Invalid
    ["", null],
    ["  ", null],
    ["90", null], // bare number, no unit
    ["abc", null],
    ["2y", null], // unsupported unit
    ["2h30", null], // trailing bare number
    ["h", null],
    ["-", null],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} → ${expected}`, () => {
      expect(parseDuration(input)).toBe(expected);
    });
  }

  it("returns null for null/undefined", () => {
    expect(parseDuration(null)).toBe(null);
    expect(parseDuration(undefined)).toBe(null);
  });
});

describe("formatDuration", () => {
  const cases: Array<[number, string]> = [
    [0, "0m"],
    [-5, "0m"],
    [30, "30m"],
    [60, "1h"],
    [90, "1h 30m"],
    [8 * 60, "1d"],
    [5 * 8 * 60, "1w"],
    [5 * 8 * 60 + 8 * 60 + 60 + 30, "1w 1d 1h 30m"],
    [150, "2h 30m"],
  ];
  for (const [input, expected] of cases) {
    it(`formats ${input} → ${JSON.stringify(expected)}`, () => {
      expect(formatDuration(input)).toBe(expected);
    });
  }

  it("round-trips through parseDuration", () => {
    for (const mins of [30, 90, 150, 480, 2400, 2400 + 480 + 90]) {
      expect(parseDuration(formatDuration(mins))).toBe(mins);
    }
  });
});
