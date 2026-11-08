/**
 * Pure reference parser for issue/PR/comment bodies.
 *
 * Issues and pull requests share one per-repo number sequence, as on GitHub
 * (#259), so `#N` names one of them; the service looks up which:
 *   - `#N`  → issue or pull request N
 *   - `!N`  → pull request N. The way pull requests were written before the
 *             shared sequence; still read, so older text keeps its links.
 *   - `@handle` → mention
 *   - `closes|fixes|resolves #N` → closing reference to N, if N is an issue
 *
 * Code spans (`` `…` ``) and fenced blocks (``` ``` ```/`~~~`) are stripped before
 * scanning, so references inside code are never parsed. This module has no I/O —
 * it is unit-tested directly.
 */

export type ParsedReferences = {
  /** Numbers referenced with `#N`: each an issue or a pull request. */
  numbers: number[];
  /** Pull-request numbers referenced with `!N`. */
  pulls: number[];
  /** Lower-cased, de-duplicated handles referenced with `@handle`. */
  mentions: string[];
  /** "org/team" for each @org/team (#253). */
  teamMentions: string[];
  /** Numbers a closing keyword (`closes #N`) points at. Subset of `numbers`. */
  closing: number[];
};

// A `#N` reference: must be preceded by a non-word char (or start) and followed by
// a non-word char, so `abc#5`, `#5x` and `C#7` don't false-positive.
const NUMBER_RE = /(^|[^0-9A-Za-z_])#(\d+)(?![0-9A-Za-z_])/g;
const PULL_RE = /(^|[^0-9A-Za-z_])!(\d+)(?![0-9A-Za-z_])/g;
// A mention: preceding char must be non-word and not `/` (so `foo@bar.com`,
// `path/@x` don't match). Handle is GitHub-shaped: alphanumerics + single hyphens,
// no leading/trailing hyphen, ≤ 39 chars.
const MENTION_RE = /(^|[^0-9A-Za-z_/])@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})(?![A-Za-z0-9])/g;
// A team mention (#253): @org/team-slug, the same left boundary as a person.
const TEAM_MENTION_RE = /(^|[^0-9A-Za-z_/])@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})(?![A-Za-z0-9_.-])/g;
// Closing keywords GitHub understands.
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
  if (!body) return { numbers: [], pulls: [], mentions: [], teamMentions: [], closing: [] };
  const text = stripCode(body);

  const numbers = uniqueNumbers(NUMBER_RE, text, 2);
  const pulls = uniqueNumbers(PULL_RE, text, 2);
  const closing = uniqueNumbers(CLOSING_RE, text, 1);

  const mentionSet = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    mentionSet.add(m[2].toLowerCase());
  }

  const teams = new Set<string>();
  for (const m of text.matchAll(TEAM_MENTION_RE)) {
    teams.add(`${m[2].toLowerCase()}/${m[3].toLowerCase()}`);
  }

  return {
    numbers,
    pulls,
    mentions: [...mentionSet],
    teamMentions: [...teams],
    closing,
  };
}
