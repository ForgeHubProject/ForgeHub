/**
 * Pure reference parser for issue/PR/comment bodies.
 *
 * ForgeHub keeps separate per-repo number sequences for issues and pull requests,
 * so plain `#N` is ambiguous. We resolve that GitLab-style:
 *   - `#N`  → issue  N
 *   - `!N`  → pull request N
 *   - `@handle` → mention
 *   - `closes|fixes|resolves #N` → closing reference to issue N
 *
 * Code spans (`` `…` ``) and fenced blocks (``` ``` ```/`~~~`) are stripped before
 * scanning, so references inside code are never parsed. This module has no I/O —
 * it is unit-tested directly.
 */

export type ParsedReferences = {
  /** Issue numbers referenced with `#N`. */
  issues: number[];
  /** Pull-request numbers referenced with `!N`. */
  pulls: number[];
  /** Lower-cased, de-duplicated handles referenced with `@handle`. */
  mentions: string[];
  /** Issue numbers a closing keyword (`closes #N`) points at. Subset of `issues`. */
  closesIssues: number[];
};

// A `#N` reference: must be preceded by a non-word char (or start) and followed by
// a non-word char, so `abc#5`, `#5x` and `C#7` don't false-positive.
const ISSUE_RE = /(^|[^0-9A-Za-z_])#(\d+)(?![0-9A-Za-z_])/g;
const PULL_RE = /(^|[^0-9A-Za-z_])!(\d+)(?![0-9A-Za-z_])/g;
// A mention: preceding char must be non-word and not `/` (so `foo@bar.com`,
// `path/@x` don't match). Handle is GitHub-shaped: alphanumerics + single hyphens,
// no leading/trailing hyphen, ≤ 39 chars.
const MENTION_RE = /(^|[^0-9A-Za-z_/])@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})(?![A-Za-z0-9])/g;
// Closing keywords GitHub understands, pointing at an issue.
const CLOSING_RE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)(?![0-9A-Za-z_])/gi;

/** Remove fenced code blocks and inline code spans so their contents aren't parsed. */
export function stripCode(input: string): string {
  return input
    // Fenced blocks first (``` … ``` and ~~~ … ~~~), non-greedy.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Inline spans: a run of N backticks closed by the same run.
    .replace(/(`+)[^\n]*?\1/g, " ");
}

function uniqueNumbers(re: RegExp, text: string, group: number): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(re)) {
    seen.add(Number(m[group]));
  }
  return [...seen].sort((a, b) => a - b);
}

/** Parse all references out of a markdown body. */
export function parseReferences(body: string | null | undefined): ParsedReferences {
  if (!body) return { issues: [], pulls: [], mentions: [], closesIssues: [] };
  const text = stripCode(body);

  const issues = uniqueNumbers(ISSUE_RE, text, 2);
  const pulls = uniqueNumbers(PULL_RE, text, 2);
  const closesIssues = uniqueNumbers(CLOSING_RE, text, 1);

  const mentionSet = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    mentionSet.add(m[2].toLowerCase());
  }

  return {
    issues,
    pulls,
    mentions: [...mentionSet],
    closesIssues,
  };
}
