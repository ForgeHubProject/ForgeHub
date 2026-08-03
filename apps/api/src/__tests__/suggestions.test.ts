import { describe, it, expect } from "vitest";
import { applySuggestionToContent } from "../suggestions.js";

describe("applySuggestionToContent", () => {
  const file = "line one\nline two\nline three\n";

  it("replaces the anchored line, preserving the trailing newline", () => {
    const result = applySuggestionToContent(file, 2, "LINE TWO");
    expect(result).toEqual({ ok: true, content: "line one\nLINE TWO\nline three\n" });
  });

  it("supports a multi-line replacement", () => {
    const result = applySuggestionToContent(file, 2, "two-a\ntwo-b");
    expect(result).toEqual({ ok: true, content: "line one\ntwo-a\ntwo-b\nline three\n" });
  });

  it("drops the suggestion's own trailing newline (textarea artifact)", () => {
    const result = applySuggestionToContent(file, 2, "LINE TWO\n");
    expect(result).toEqual({ ok: true, content: "line one\nLINE TWO\nline three\n" });
  });

  it("an empty suggestion deletes the line", () => {
    const result = applySuggestionToContent(file, 2, "");
    expect(result).toEqual({ ok: true, content: "line one\nline three\n" });
  });

  it("handles a file without a trailing newline", () => {
    const result = applySuggestionToContent("a\nb", 2, "B");
    expect(result).toEqual({ ok: true, content: "a\nB" });
  });

  it("can replace the last line", () => {
    const result = applySuggestionToContent(file, 3, "the end");
    expect(result).toEqual({ ok: true, content: "line one\nline two\nthe end\n" });
  });

  it("rejects a line below 1", () => {
    const result = applySuggestionToContent(file, 0, "x");
    expect(result.ok).toBe(false);
  });

  it("rejects a line beyond the end of the file, naming the current length", () => {
    const result = applySuggestionToContent(file, 4, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/3 lines/);
  });

  it("deleting the only line of a file yields an empty file", () => {
    const result = applySuggestionToContent("solo\n", 1, "");
    expect(result).toEqual({ ok: true, content: "" });
  });
});
