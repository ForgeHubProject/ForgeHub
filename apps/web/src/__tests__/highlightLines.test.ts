/**
 * The code view draws highlighted HTML one table row per source line, so the
 * split must give exactly one entry per line, each standing on its own: before
 * the fix, every line after the first started with a "\n" (drawn as an empty
 * first line under white-space: pre, so every row was double height), and a
 * token spanning lines merged them into one entry, shifting the code below it
 * away from its line numbers.
 */
import { describe, it, expect } from "vitest";
import { highlightCode, splitHighlightedLines } from "../lib/highlight";

/** The text an HTML line shows: tags dropped, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function check(code: string, lang: string) {
  const lines = splitHighlightedLines(highlightCode(code, lang));
  expect(lines).toHaveLength(code.split("\n").length);
  expect(lines.map(text)).toEqual(code.split("\n"));
  for (const l of lines) {
    expect(l.startsWith("\n")).toBe(false);
    // Every line's tags balance on their own.
    expect((l.match(/<span[^>]*>/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
  }
  return lines;
}

describe("splitHighlightedLines", () => {
  it("gives one self-contained entry per line of JSON (the notebook in the report)", () => {
    check('{\n "nbformat": 4,\n "metadata": {\n  "kernelspec": {"name": "python3"}\n },\n "cells": []\n}\n', "json");
  });

  it("keeps lines aligned through a multi-line comment and template string", () => {
    const code = [
      "const a = 1;",
      "/* a comment",
      "   over three",
      "   lines */",
      "const s = `one",
      "two ${a}",
      "three`;",
      "const b = 2;",
    ].join("\n");
    const lines = check(code, "javascript");
    // The comment's middle line is still inside the comment's span.
    expect(lines[2]).toMatch(/^<span class="hljs-comment">/);
    // And the code after it is on its own line number.
    expect(text(lines[7]!)).toBe("const b = 2;");
  });

  it("handles a file with no trailing newline, an empty file, and blank lines", () => {
    check("a\n\nb", "plaintext");
    check("", "plaintext");
    check("\n\n", "plaintext");
  });

  it("escaped text stays escaped", () => {
    const [line] = splitHighlightedLines(highlightCode("if (a < b && c > d) {}", "javascript"));
    expect(line).toContain("&lt;");
    expect(line).not.toMatch(/<(?!\/?span)/);
  });
});
