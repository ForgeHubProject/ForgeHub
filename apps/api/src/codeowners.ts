import { readFileAtBranch } from "./git-utils.js";

/**
 * CODEOWNERS: gitignore-style path patterns mapped to `@handle`s (issue #89).
 *
 * Grammar (v0):
 *   - `#` starts a comment (rest of the line); blank lines are skipped.
 *   - A line is `<pattern> <@owner>...`. Owner tokens that aren't `@handle`
 *     (emails, `@org/team`) are IGNORED — ForgeHub ownership is per-user.
 *   - `!pattern` NEGATES: a matching negated rule leaves the path unowned. A
 *     rule with a pattern but no owners does the same (GitHub's way of carving
 *     an exception out of a broader rule).
 *   - LAST MATCH WINS: rules are evaluated top to bottom and the last one that
 *     matches a path decides its owners, so specific rules go below broad ones.
 *
 * Pattern semantics follow gitignore: `*` matches within a path segment, `**`
 * spans segments, `?` is one non-separator character, `[abc]`/`[a-z]` are
 * character classes, a leading `/` (or any interior `/`) anchors to the repo
 * root, an otherwise slash-free pattern matches at any depth, and a trailing `/`
 * restricts the rule to a directory's contents. A pattern that names a directory
 * also owns everything beneath it.
 *
 * Parsing is total: a line that yields no usable pattern is dropped, never
 * thrown — a malformed CODEOWNERS must not block PR creation.
 */

export type CodeownersRule = {
  /** 1-based line number in the source file (for diagnostics). */
  line: number;
  /** The pattern as written, minus any `!`. */
  pattern: string;
  /** Lowercased handles without the `@`; empty for a negated or owner-less rule. */
  owners: string[];
  /** `!pattern` — a match clears ownership instead of assigning it. */
  negated: boolean;
  /** Compiled matcher for `pattern`. */
  match: RegExp;
};

/** Conventional locations, most specific first; the first file that exists wins. */
export const CODEOWNERS_PATHS = [".forgehub/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

const HANDLE = /^@([A-Za-z0-9][A-Za-z0-9-_]*)$/;

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate one gitignore-style pattern into an anchored RegExp over a
 * repo-relative POSIX path. Returns null when nothing is left to match on.
 */
export function compilePattern(pattern: string): RegExp | null {
  let p = pattern;

  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  // A leading `/` only anchors; an interior `/` anchors too (gitignore rule).
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  if (!p) return null;

  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        const atSegmentStart = i === 0 || p[i - 1] === "/";
        // `a/**/b` (and a leading `**/`) may also match zero segments.
        if (atSegmentStart && p[i + 2] === "/") { body += "(?:.*/)?"; i += 2; }
        else { body += ".*"; i += 1; }
      } else {
        body += "[^/]*";
      }
    } else if (c === "?") {
      body += "[^/]";
    } else if (c === "[") {
      const close = p.indexOf("]", i + 1);
      if (close < 0) { body += "\\["; continue; }
      const inner = p.slice(i + 1, close);
      body += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`;
      i = close;
    } else {
      body += escapeLiteral(c);
    }
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // Directory patterns own the contents only; everything else also owns the
  // subtree when the pattern happens to name a directory.
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  try {
    return new RegExp(prefix + body + suffix);
  } catch {
    return null;
  }
}

/** Parse a CODEOWNERS file into rules, in file order. Unusable lines are dropped. */
export function parseCodeowners(raw: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const hash = lines[i]!.indexOf("#");
    const text = (hash >= 0 ? lines[i]!.slice(0, hash) : lines[i]!).trim();
    if (!text) continue;

    const [rawPattern, ...ownerTokens] = text.split(/\s+/);
    if (!rawPattern) continue;

    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    const match = compilePattern(pattern);
    if (!match) continue;

    const owners: string[] = [];
    if (!negated) {
      for (const token of ownerTokens) {
        const handle = HANDLE.exec(token)?.[1]?.toLowerCase();
        if (handle && !owners.includes(handle)) owners.push(handle);
      }
    }
    rules.push({ line: i + 1, pattern, owners, negated, match });
  }

  return rules;
}

/** Normalize a changed-file path to the repo-relative form patterns match against. */
function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Owners of one path under last-match-wins. A negated (or owner-less) last match
 * means the path is deliberately unowned, so the answer is `[]` — NOT a fallback
 * to the previous match.
 */
export function ownersForPath(rules: CodeownersRule[], filePath: string): string[] {
  const path = normalizePath(filePath);
  let owners: string[] = [];
  for (const rule of rules) {
    if (!rule.match.test(path)) continue;
    owners = rule.negated ? [] : rule.owners;
  }
  return owners;
}

/** Union of the owners of every path, in first-seen order (paths then rule order). */
export function ownersForPaths(rules: CodeownersRule[], filePaths: string[]): string[] {
  if (rules.length === 0) return [];
  const seen: string[] = [];
  for (const filePath of filePaths) {
    for (const owner of ownersForPath(rules, filePath)) {
      if (!seen.includes(owner)) seen.push(owner);
    }
  }
  return seen;
}

/**
 * Read + parse the repo's CODEOWNERS at a ref, checking the conventional
 * locations in order. Missing everywhere → no rules.
 *
 * The read goes through `readFileAtBranch`, whose trimming is fine here: this
 * file is consumed as a list of lines, so surrounding whitespace carries no
 * meaning (unlike a template body, which is read byte-exact).
 */
export async function loadCodeowners(storageKey: string, ref: string): Promise<CodeownersRule[]> {
  for (const path of CODEOWNERS_PATHS) {
    const raw = await readFileAtBranch(storageKey, ref, path);
    if (raw !== null) return parseCodeowners(raw);
  }
  return [];
}
