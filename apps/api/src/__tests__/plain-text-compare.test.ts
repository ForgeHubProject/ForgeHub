import { describe, it, expect } from "vitest";
import { comparePlainTextSnapshots } from "../handlers/plain-text/compare.js";

describe("comparePlainTextSnapshots", () => {
  const BASE = "snap-base";
  const TARGET = "snap-target";

  it("returns kind=plain-text", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "", "");
    expect(result.kind).toBe("plain-text");
    expect(result.baseSnapshotId).toBe(BASE);
    expect(result.targetSnapshotId).toBe(TARGET);
  });

  it("empty vs empty → no lines, all zeros", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "", "");
    expect(result.lines).toHaveLength(0);
    expect(result.summary).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });

  it("identical single line → unchanged", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "hello", "hello");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({ type: "unchanged", content: "hello", oldLine: 1, newLine: 1 });
    expect(result.summary).toEqual({ added: 0, removed: 0, unchanged: 1 });
  });

  it("identical multi-line → all unchanged", () => {
    const text = "a\nb\nc";
    const result = comparePlainTextSnapshots(BASE, TARGET, text, text);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => l.type === "unchanged")).toBe(true);
    expect(result.summary).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it("added lines in target → all added with correct line numbers", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "", "x\ny");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({ type: "added", content: "x", oldLine: null, newLine: 1 });
    expect(result.lines[1]).toEqual({ type: "added", content: "y", oldLine: null, newLine: 2 });
    expect(result.summary).toEqual({ added: 2, removed: 0, unchanged: 0 });
  });

  it("removed lines from base → all removed with correct line numbers", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "x\ny", "");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({ type: "removed", content: "x", oldLine: 1, newLine: null });
    expect(result.lines[1]).toEqual({ type: "removed", content: "y", oldLine: 2, newLine: null });
    expect(result.summary).toEqual({ added: 0, removed: 2, unchanged: 0 });
  });

  it("completely different text → all removed then all added", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "a\nb", "x\ny");
    const removed = result.lines.filter((l) => l.type === "removed");
    const added = result.lines.filter((l) => l.type === "added");
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(result.summary).toEqual({ added: 2, removed: 2, unchanged: 0 });
  });

  it("mixed edit preserves unchanged context lines", () => {
    const base = "header\nold line\nfooter";
    const target = "header\nnew line\nfooter";
    const result = comparePlainTextSnapshots(BASE, TARGET, base, target);

    const unchanged = result.lines.filter((l) => l.type === "unchanged");
    expect(unchanged.map((l) => l.content)).toEqual(["header", "footer"]);
    expect(result.summary.unchanged).toBe(2);
    expect(result.summary.removed).toBe(1);
    expect(result.summary.added).toBe(1);
  });

  it("line numbers increment correctly across mixed types", () => {
    const base = "a\nb\nc";
    const target = "a\nX\nc";
    const result = comparePlainTextSnapshots(BASE, TARGET, base, target);

    const a = result.lines.find((l) => l.content === "a")!;
    expect(a.oldLine).toBe(1);
    expect(a.newLine).toBe(1);

    const removed = result.lines.find((l) => l.type === "removed")!;
    expect(removed.oldLine).toBe(2);
    expect(removed.newLine).toBeNull();

    const added = result.lines.find((l) => l.type === "added")!;
    expect(added.oldLine).toBeNull();
    expect(added.newLine).toBe(2);

    const c = result.lines.find((l) => l.content === "c")!;
    expect(c.oldLine).toBe(3);
    expect(c.newLine).toBe(3);
  });

  it("trailing newline is stripped (not counted as an extra blank line)", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "a\nb\n", "a\nb\n");
    expect(result.lines).toHaveLength(2);
    expect(result.summary.unchanged).toBe(2);
  });

  it("CRLF line endings are treated the same as LF", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "a\r\nb\r\n", "a\nb");
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((l) => l.type === "unchanged")).toBe(true);
  });

  it("appended lines at end", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "a", "a\nb\nc");
    expect(result.summary).toEqual({ added: 2, removed: 0, unchanged: 1 });
    const added = result.lines.filter((l) => l.type === "added");
    expect(added[0]!.newLine).toBe(2);
    expect(added[1]!.newLine).toBe(3);
  });

  it("prepended lines at start", () => {
    const result = comparePlainTextSnapshots(BASE, TARGET, "c", "a\nb\nc");
    expect(result.summary).toEqual({ added: 2, removed: 0, unchanged: 1 });
  });

  it("summary counts match the lines array", () => {
    const base = "line1\nshared\nline3";
    const target = "new1\nshared\nnew3\nextra";
    const result = comparePlainTextSnapshots(BASE, TARGET, base, target);
    const actualAdded = result.lines.filter((l) => l.type === "added").length;
    const actualRemoved = result.lines.filter((l) => l.type === "removed").length;
    const actualUnchanged = result.lines.filter((l) => l.type === "unchanged").length;
    expect(result.summary.added).toBe(actualAdded);
    expect(result.summary.removed).toBe(actualRemoved);
    expect(result.summary.unchanged).toBe(actualUnchanged);
  });
});
