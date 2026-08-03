/**
 * Suggested-change application (issue #119): the pure text transform behind the
 * apply endpoint. A suggestion replaces exactly ONE line of the file at the PR
 * head — the line the review comment is anchored to — with the (possibly
 * multi-line) replacement text. Kept free of git/prisma so the splice semantics
 * are unit-testable in isolation.
 */

export type SuggestionApplyResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * Replace 1-based line `line` of `content` with `suggestion`. The suggestion's
 * own trailing newline (an artifact of textarea input) is dropped; an EMPTY
 * suggestion deletes the line. The file's trailing-newline state is preserved.
 */
export function applySuggestionToContent(
  content: string,
  line: number,
  suggestion: string,
): SuggestionApplyResult {
  const hadTrailingNewline = content.endsWith("\n");
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = body === "" ? [] : body.split("\n");

  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return { ok: false, error: `Line ${line} is out of range — the file has ${lines.length} line${lines.length === 1 ? "" : "s"} at the current head` };
  }

  const replacementRaw = suggestion.endsWith("\n") ? suggestion.slice(0, -1) : suggestion;
  const replacement = replacementRaw === "" ? [] : replacementRaw.split("\n");
  lines.splice(line - 1, 1, ...replacement);

  const next = lines.join("\n");
  return { ok: true, content: hadTrailingNewline && next !== "" ? `${next}\n` : next };
}
