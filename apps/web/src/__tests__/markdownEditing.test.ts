import { describe, it, expect } from "vitest";
import { activeTrigger, applyFormat, attachmentMarkdown, completeTrigger, replacePlaceholder, uploadPlaceholder } from "../lib/markdownEditing";

const at = (text: string, selStart: number, selEnd = selStart) => ({ text, selStart, selEnd });
const selected = (e: { text: string; selStart: number; selEnd: number }) => e.text.slice(e.selStart, e.selEnd);

describe("applyFormat", () => {
  it("wraps a selection in bold and keeps it selected", () => {
    const e = applyFormat(at("make this loud", 5, 9), "bold");
    expect(e.text).toBe("make **this** loud");
    expect(selected(e)).toBe("this");
  });

  it("keeps spaces at the selection's edges outside the markers", () => {
    const e = applyFormat(at("say hello there", 3, 10), "bold");
    expect(e.text).toBe("say **hello** there");
    expect(selected(e)).toBe("hello");
  });

  it("inserts a selected placeholder when nothing is selected", () => {
    const e = applyFormat(at("x ", 2), "italic");
    expect(e.text).toBe("x _italic text_");
    expect(selected(e)).toBe("italic text");
  });

  it("uses a fence for multi-line code and backticks for one line", () => {
    expect(applyFormat(at("a\nb", 0, 3), "code").text).toBe("```\na\nb\n```");
    expect(applyFormat(at("run npm", 4, 7), "code").text).toBe("run `npm`");
  });

  it("makes a link with the url selected to type over", () => {
    const e = applyFormat(at("see docs", 4, 8), "link");
    expect(e.text).toBe("see [docs](url)");
    expect(selected(e)).toBe("url");
  });

  it("prefixes every selected line for lists and quotes", () => {
    expect(applyFormat(at("one\ntwo\nthree", 0, 13), "numbered").text).toBe("1. one\n2. two\n3. three");
    expect(applyFormat(at("one\ntwo", 0, 7), "quote").text).toBe("> one\n> two");
    expect(applyFormat(at("todo", 0, 4), "task").text).toBe("- [ ] todo");
  });

  it("prefixes only the caret's line, and moves the caret with it", () => {
    const e = applyFormat(at("first\nsecond", 8), "heading");
    expect(e.text).toBe("first\n### second");
    expect(e.selStart).toBe(12);
  });
});

describe("activeTrigger", () => {
  it("keeps a team mention (@org/team) as one token, and nothing else across a slash", () => {
    expect(activeTrigger("cc @acme/des", 12)).toEqual({ char: "@", query: "acme/des", start: 3 });
    expect(activeTrigger("see #a/b", 8)).toBeNull();
  });

  it("finds @, # and : tokens at the caret", () => {
    expect(activeTrigger("cc @ali", 7)).toEqual({ char: "@", query: "ali", start: 3 });
    expect(activeTrigger("fixes #12", 9)).toEqual({ char: "#", query: "12", start: 6 });
    expect(activeTrigger("nice :tad", 9)).toEqual({ char: ":", query: "tad", start: 5 });
    expect(activeTrigger("@", 1)).toEqual({ char: "@", query: "", start: 0 });
  });

  it("ignores emails, C#, times and tokens the caret has left", () => {
    expect(activeTrigger("a@b.com", 7)).toBeNull();
    expect(activeTrigger("C#", 2)).toBeNull();
    expect(activeTrigger("at 10:30", 8)).toBeNull();
    expect(activeTrigger("@bob done", 9)).toBeNull();
  });
});

describe("completeTrigger", () => {
  it("replaces the token and leaves the caret after a space", () => {
    const text = "thanks @ali for this";
    const trigger = activeTrigger(text, 11)!;
    const done = completeTrigger(text, 11, trigger, "@alice");
    expect(done.text).toBe("thanks @alice for this");
    expect(done.caret).toBe(14);
  });

  it("adds the space at the end of the text", () => {
    const done = completeTrigger("cc @al", 6, activeTrigger("cc @al", 6)!, "@alice");
    expect(done).toEqual({ text: "cc @alice ", caret: 10 });
  });
});

describe("uploads (#253)", () => {
  const url = "https://forge.example/attachments/0123456789abcdef0123456789abcdef";

  it("an image shows inline, any other file is a link, and brackets in a name can't break out", () => {
    expect(uploadPlaceholder("shot.png")).toBe("[Uploading shot.png…]()");
    expect(attachmentMarkdown({ name: "shot.png", contentType: "image/png" }, url)).toBe(`![shot.png](${url})`);
    expect(attachmentMarkdown({ name: "spec.pdf", contentType: "application/pdf" }, url)).toBe(`[spec.pdf](${url})`);
    expect(attachmentMarkdown({ name: "a]b[c.txt", contentType: "text/plain; charset=utf-8" }, url)).toBe(`[a\\]b\\[c.txt](${url})`);
    expect(uploadPlaceholder("x]")).toBe("[Uploading x\\]…]()");
  });

  it("swaps the placeholder for the link and keeps the caret in the text after it", () => {
    const ph = uploadPlaceholder("shot.png");
    const text = `see ${ph} and more`;
    const caret = text.length; // typing on at the end
    const done = replacePlaceholder(at(text, caret), ph, "![shot.png](u)");
    expect(done.text).toBe("see ![shot.png](u) and more");
    expect(done.selStart).toBe(done.text.length);
    // A caret before the placeholder stays put; one inside it lands after the replacement.
    expect(replacePlaceholder(at(text, 2), ph, "L")).toEqual(at("see L and more", 2));
    expect(replacePlaceholder(at(text, 6), ph, "L")).toEqual(at("see L and more", 5));
  });

  it("a failed upload drops its placeholder; a deleted placeholder leaves the text alone", () => {
    const ph = uploadPlaceholder("big.zip");
    expect(replacePlaceholder(at(`a ${ph} b`, 0), ph, "").text).toBe("a  b");
    const edited = at("the placeholder was deleted", 3);
    expect(replacePlaceholder(edited, ph, "L")).toBe(edited);
  });
});
