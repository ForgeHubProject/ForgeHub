/**
 * The comment box's text operations (#253), kept pure so they're unit-tested:
 * toolbar formatting around the selection, the `@` / `#` / `:` token the
 * caret is in, for autocomplete, and the links uploaded files become.
 */

export type Edit = { text: string; selStart: number; selEnd: number };

export type Format =
  | "heading" | "bold" | "italic" | "quote" | "code" | "link"
  | "bulleted" | "numbered" | "task";

/**
 * Wrap the selection in `before`/`after`; an empty selection gets `placeholder`,
 * selected. Spaces at the selection's edges stay outside the markers, since
 * `**bold **` isn't bold in Markdown.
 */
function wrap(e: Edit, before: string, after: string, placeholder: string): Edit {
  const raw = e.text.slice(e.selStart, e.selEnd);
  const lead = /^\s*/.exec(raw)![0];
  const trail = raw.trim() ? /\s*$/.exec(raw)![0] : "";
  const inner = raw.trim() ? raw.slice(lead.length, raw.length - trail.length) : placeholder;
  const text = e.text.slice(0, e.selStart) + (raw.trim() ? lead : "") + before + inner + after + trail + e.text.slice(e.selEnd);
  const start = e.selStart + (raw.trim() ? lead.length : 0) + before.length;
  return { text, selStart: start, selEnd: start + inner.length };
}

/** Prefix every line the selection touches; `prefix(i)` for the i-th line. */
function prefixLines(e: Edit, prefix: (i: number) => string): Edit {
  const lineStart = e.text.lastIndexOf("\n", e.selStart - 1) + 1;
  const nl = e.text.indexOf("\n", Math.max(e.selEnd - (e.selEnd > e.selStart ? 1 : 0), e.selStart));
  const lineEnd = nl === -1 ? e.text.length : nl;
  const lines = e.text.slice(lineStart, lineEnd).split("\n");
  const block = lines.map((l, i) => prefix(i) + l).join("\n");
  const text = e.text.slice(0, lineStart) + block + e.text.slice(lineEnd);
  const added = block.length - (lineEnd - lineStart);
  // A caret (no selection) moves with its line's prefix; a selection covers the block.
  return e.selStart === e.selEnd
    ? { text, selStart: e.selStart + prefix(0).length, selEnd: e.selEnd + prefix(0).length }
    : { text, selStart: lineStart, selEnd: lineEnd + added };
}

/** Apply one toolbar button (or its shortcut) to the text and selection. */
export function applyFormat(e: Edit, format: Format): Edit {
  switch (format) {
    case "heading": return prefixLines(e, () => "### ");
    case "bold": return wrap(e, "**", "**", "bold text");
    case "italic": return wrap(e, "_", "_", "italic text");
    case "quote": return prefixLines(e, () => "> ");
    case "code": {
      const selected = e.text.slice(e.selStart, e.selEnd);
      return selected.includes("\n") ? wrap(e, "```\n", "\n```", "") : wrap(e, "`", "`", "code");
    }
    case "link": {
      // [text](url), with "url" selected to type over.
      const label = e.text.slice(e.selStart, e.selEnd) || "text";
      const text = e.text.slice(0, e.selStart) + `[${label}](url)` + e.text.slice(e.selEnd);
      const urlStart = e.selStart + label.length + 3;
      return { text, selStart: urlStart, selEnd: urlStart + 3 };
    }
    case "bulleted": return prefixLines(e, () => "- ");
    case "numbered": return prefixLines(e, (i) => `${i + 1}. `);
    case "task": return prefixLines(e, () => "- [ ] ");
  }
}

export type Trigger = { char: "@" | "#" | ":"; query: string; start: number };

/**
 * The autocomplete token ending at the caret: `@handle`, `#123` or `#words`,
 * `:smile`. It must start a word, so `a@b.com` and `C#` don't trigger, and
 * `:` waits for a letter so times like `10:30` don't either.
 */
export function activeTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])([@#:])([\w.+/-]*)$/.exec(before);
  if (!m) return null;
  const char = m[2] as Trigger["char"];
  const query = m[3];
  // A slash belongs to team mentions only (#253): @org/team.
  if (query.includes("/") && char !== "@") return null;
  if (char === ":" && !/^[a-z+-]/i.test(query)) return null;
  if (query.length > 40) return null;
  return { char, query, start: caret - query.length - 1 };
}

/** Replace the token with `replacement` and a space (unless one follows), leaving the caret after it. */
export function completeTrigger(text: string, caret: number, trigger: Trigger, replacement: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const space = /^\s/.test(after) ? "" : " ";
  const next = text.slice(0, trigger.start) + replacement + space + after;
  return { text: next, caret: trigger.start + replacement.length + 1 };
}

const linkText = (name: string) => name.replace(/[\\[\]]/g, "\\$&");

/** What stands in the text for a file while it uploads (#253). */
export function uploadPlaceholder(name: string): string {
  return `[Uploading ${linkText(name)}…]()`;
}

/** An uploaded file's link: an image shows inline, anything else is a link to download it. */
export function attachmentMarkdown(a: { name: string; contentType: string }, url: string): string {
  return `${a.contentType.startsWith("image/") ? "!" : ""}[${linkText(a.name)}](${url})`;
}

/**
 * Put `replacement` where the placeholder is ("" drops it), keeping the selection
 * where it was in the text around it. Text whose placeholder was deleted stays as it is.
 */
export function replacePlaceholder(e: Edit, placeholder: string, replacement: string): Edit {
  const at = e.text.indexOf(placeholder);
  if (at === -1) return e;
  const end = at + placeholder.length;
  const move = (pos: number) => (pos <= at ? pos : pos >= end ? pos - placeholder.length + replacement.length : at + replacement.length);
  return { text: e.text.slice(0, at) + replacement + e.text.slice(end), selStart: move(e.selStart), selEnd: move(e.selEnd) };
}

/** The `:` autocomplete's emoji: GitHub's common shortcodes, inserted as the character. */
export const EMOJI: ReadonlyArray<[string, string]> = [
  ["+1", "👍"], ["-1", "👎"], ["smile", "😄"], ["laughing", "😆"], ["blush", "😊"], ["heart", "❤️"],
  ["tada", "🎉"], ["rocket", "🚀"], ["eyes", "👀"], ["thinking", "🤔"], ["confused", "😕"], ["cry", "😢"],
  ["fire", "🔥"], ["sparkles", "✨"], ["star", "⭐"], ["100", "💯"], ["clap", "👏"], ["pray", "🙏"],
  ["wave", "👋"], ["ok_hand", "👌"], ["muscle", "💪"], ["bug", "🐛"], ["warning", "⚠️"], ["x", "❌"],
  ["white_check_mark", "✅"], ["heavy_check_mark", "✔️"], ["question", "❓"], ["bulb", "💡"], ["memo", "📝"],
  ["lock", "🔒"], ["zap", "⚡"], ["art", "🎨"], ["wrench", "🔧"], ["hammer", "🔨"], ["package", "📦"],
  ["construction", "🚧"], ["recycle", "♻️"], ["coffee", "☕"], ["sweat_smile", "😅"], ["joy", "😂"],
  ["wink", "😉"], ["sunglasses", "😎"], ["party", "🥳"], ["see_no_evil", "🙈"], ["point_up", "☝️"],
];
