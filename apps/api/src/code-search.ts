import { spawn } from "node:child_process";
import { bareRepoPathFromKey } from "./git-storage.js";

/**
 * Repository code search over the git object store — the raw-bytes half of
 * issue #111. A single match line inside a file. `line` is 1-based; `preview`
 * is the (capped) source line text.
 */
export type CodeMatch = { line: number; preview: string };

/** All matches for one file, in file order, grouped for per-file result cards. */
export type CodeFileHit = { path: string; matches: CodeMatch[] };

export type CodeGrepResult = {
  files: CodeFileHit[];
  /** Total match lines returned (≤ the cap). */
  totalMatches: number;
  /** True when the cap was hit and more matches exist than were returned. */
  truncated: boolean;
  /** True when the subprocess was killed by the timebox (results are partial). */
  timedOut: boolean;
};

/** A `/search`-style query string decomposed into free text + qualifiers. */
export type CodeQuery = {
  /** The literal/regex needle, with all qualifiers stripped out. */
  text: string;
  /** `repo:owner/name` scope (meaningful for global search; ignored when already repo-scoped). */
  repo?: { owner: string; name: string };
  /** `path:` prefix filters — a path is kept if it starts with any of these. */
  pathPrefixes: string[];
  /** `ext:` filters — a path is kept if its extension matches any of these (no leading dot). */
  exts: string[];
};

const MAX_PREVIEW = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
export const DEFAULT_GREP_TIMEOUT_MS = 5_000;

/** Clamp a caller-supplied result cap to a sane range. */
export function clampLimit(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

/**
 * Split a raw query into free text and the `repo:` / `path:` / `ext:` qualifiers
 * ForgeHub reuses from the existing `/search` syntax. Values may be quoted
 * (`path:"src/a b"`). Everything not consumed by a qualifier is the search text.
 */
export function parseCodeQuery(raw: string): CodeQuery {
  const pathPrefixes: string[] = [];
  const exts: string[] = [];
  let repo: { owner: string; name: string } | undefined;

  const text = raw
    .replace(/\b(repo|path|ext):("[^"]+"|\S+)/gi, (_m, key: string, val: string) => {
      const v = val.replace(/^"|"$/g, "").trim();
      switch (key.toLowerCase()) {
        case "repo": {
          const slash = v.indexOf("/");
          if (slash > 0 && slash < v.length - 1) {
            repo = { owner: v.slice(0, slash), name: v.slice(slash + 1) };
          }
          break;
        }
        case "path":
          if (v) pathPrefixes.push(v.replace(/^\/+/, ""));
          break;
        case "ext":
          if (v) exts.push(v.replace(/^\.+/, "").toLowerCase());
          break;
      }
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  return { text, repo, pathPrefixes, exts };
}

/**
 * Turn `path:` / `ext:` filters into git pathspecs. Multiple pathspecs are ORed
 * by git grep (a file matching ANY spec is searched), so path/ext filters widen
 * rather than intersect — a deliberate v0 simplification.
 */
export function buildPathspecs(q: CodeQuery): string[] {
  const specs: string[] = [];
  for (const prefix of q.pathPrefixes) {
    // Anchored (no leading `**`) glob: matches any full path beginning with `prefix`.
    specs.push(`:(glob)${prefix}**`);
  }
  for (const ext of q.exts) {
    // Leading `**/` matches zero-or-more dirs, so both `a.ext` and `d/a.ext` match.
    specs.push(`:(glob)**/*.${ext}`);
  }
  return specs;
}

type ProcResult = { stdout: string; code: number | null; timedOut: boolean };

/**
 * Spawn a command, collect its stdout, and hard-kill it if it runs past
 * `timeoutMs` — returning whatever stdout arrived plus `timedOut: true`. This is
 * the timebox that stops a pathological pattern or a huge tree from hanging the
 * API: the subprocess is bounded, partial output is preserved, and the caller
 * surfaces a truncation/timeout notice rather than blocking a request forever.
 */
export function runWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timedOut = false;

    const child = spawn(command, args, { cwd });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code, timedOut });
    };

    // On timeout, hard-kill and resolve immediately with whatever stdout arrived
    // — don't wait for `close`, which can stall if a grandchild inherits the pipe.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", () => { /* drained; errors surface as empty results */ });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Parse `git grep -z -n` output (records: `<ref>:<path>\0<line>\0<text>\n`) into
 * per-file hits, stripping the leading `<ref>:` and capping total matches at
 * `limit` (flagging `truncated`). Kept pure and exported so the parse/cap/group
 * logic is unit-tested without spawning git.
 */
export function parseGrepOutput(
  stdout: string,
  ref: string,
  limit: number,
  timedOut: boolean,
): CodeGrepResult {
  const refPrefix = `${ref}:`;
  const byFile = new Map<string, CodeMatch[]>();
  const order: string[] = [];
  let total = 0;
  let truncated = false;

  for (const record of stdout.split("\n")) {
    if (!record) continue;
    const nul1 = record.indexOf("\0");
    if (nul1 < 0) continue;
    const nul2 = record.indexOf("\0", nul1 + 1);
    if (nul2 < 0) continue;

    let path = record.slice(0, nul1);
    if (path.startsWith(refPrefix)) path = path.slice(refPrefix.length);
    const line = parseInt(record.slice(nul1 + 1, nul2), 10);
    if (!Number.isFinite(line)) continue;
    let preview = record.slice(nul2 + 1).replace(/\r$/, "");
    if (preview.length > MAX_PREVIEW) preview = preview.slice(0, MAX_PREVIEW);

    if (total >= limit) { truncated = true; break; }

    let matches = byFile.get(path);
    if (!matches) { matches = []; byFile.set(path, matches); order.push(path); }
    matches.push({ line, preview });
    total++;
  }

  return { files: order.map((p) => ({ path: p, matches: byFile.get(p)! })), totalMatches: total, truncated, timedOut };
}

export type CodeGrepOptions = {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  pathspecs?: string[];
  limit?: number;
  timeoutMs?: number;
};

/**
 * Run `git grep` over the tree at `ref` in a bare repo and return grouped,
 * capped, timeboxed results. Fixed-string by default (`-F`), opt-in regex
 * (`-E`); case-insensitive by default with an opt-in case-sensitive flag.
 * Binary files are skipped (`-I`). git grep exits 1 for "no matches" (not an
 * error) and >1 for a bad pattern — both yield an empty result here.
 */
export async function runCodeGrep(
  storageKey: string,
  ref: string,
  opts: CodeGrepOptions,
): Promise<CodeGrepResult> {
  const {
    pattern,
    regex = false,
    caseSensitive = false,
    pathspecs = [],
    limit = DEFAULT_LIMIT,
    timeoutMs = DEFAULT_GREP_TIMEOUT_MS,
  } = opts;

  const cwd = bareRepoPathFromKey(storageKey);
  const args = ["grep", "-n", "-I", "-z", "--no-color", "--full-name"];
  if (!caseSensitive) args.push("-i");
  args.push(regex ? "-E" : "-F");
  // `--` terminates flags so a pattern starting with `-` is never mistaken for one.
  args.push("-e", pattern, ref);
  if (pathspecs.length > 0) args.push("--", ...pathspecs);

  const { stdout, timedOut } = await runWithTimeout("git", args, cwd, timeoutMs);
  return parseGrepOutput(stdout, ref, limit, timedOut);
}
