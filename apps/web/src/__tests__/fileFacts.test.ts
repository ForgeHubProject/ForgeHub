/**
 * The file header's facts (#225), written GitHub's way.
 */
import { describe, it, expect } from "vitest";
import { formatBytes, lineStats } from "../lib/fileFacts";

describe("formatBytes", () => {
  it("writes bytes, then KB, MB, GB with one decimal under ten", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
    expect(formatBytes(1)).toBe("1 Byte");
    expect(formatBytes(520)).toBe("520 Bytes");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(45 * 1024)).toBe("45 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatBytes(31457280)).toBe("30 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});

describe("lineStats", () => {
  it("counts lines and the non-blank ones", () => {
    expect(lineStats("a\n\n  \nb\n")).toEqual({ lines: 4, loc: 2 });
  });

  it("doesn't count a final newline as a line, and an empty file has none", () => {
    expect(lineStats("one\n")).toEqual({ lines: 1, loc: 1 });
    expect(lineStats("one")).toEqual({ lines: 1, loc: 1 });
    expect(lineStats("")).toEqual({ lines: 0, loc: 0 });
  });
});
