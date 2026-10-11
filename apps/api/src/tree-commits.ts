import { spawn } from "node:child_process";
import { bareRepoPathFromKey } from "./git-storage.js";
import { defaultBranch, git, listTree, resolveRefSha } from "./git-utils.js";

/**
 * The last commit to touch each entry of a directory listing — the message and
 * date columns of the file list (issue #210). Per entry, the answer is exactly
 * `git log -1 <ref> -- <entry>`.
 *
 * Asking that once per entry would be one process per row (200 for a folder of
 * 200 files), so one `git log` walk does the work: newest first, it lists the
 * paths each commit changed, credits each to the entry it falls under (its
 * first segment below the directory), and stops — git is killed — the moment
 * every entry has its commit. Past MAX_WALK commits it stops anyway, and an
 * entry untouched for that long is left out rather than made slow.
 *
 * One walk equals the per-entry answers only while history is a line. At a
 * merge, git's per-path simplification follows a parent the merge is TREESAME
 * to *for that path* and drops the rest — a side edit a merge threw away is
 * never that path's last commit — and one walk over many paths cannot follow a
 * different parent per path. So the walk notes where the first merge sits on
 * the tip's line: entries credited above it are exact, and entries credited
 * past it are asked again, one `git log -1` each. A history without merges —
 * a gateway committing straight to main, a squash-merge workflow — costs one
 * process.
 */

export type EntryCommit = { sha: string; subject: string; date: string };

export type TreeCommits = {
  ref: string;
  sha: string;
  path: string;
  /** Entry name → the last commit that touched it. */
  commits: Record<string, EntryCommit>;
  /** False when the walk hit its cap before every entry was resolved. */
  complete: boolean;
  /** Commits reachable from the ref — the "N commits" link. */
  totalCommits: number;
};

export const MAX_WALK = 5000;

// `git log -z --name-only` with this format writes, per commit:
//   \x1e <sha> \x1f <ISO date> \x1f <subject> \0 \n <path> \0 <path> \0 …
// Merges list no paths. -z keeps paths raw: no quoting, newlines and all.
const LOG_FORMAT = "%x1e%H%x1f%aI%x1f%s";

/** Past this many entries, the walk's pathspec is the directory rather than a list. */
const MAX_PATHSPECS = 1000;

/** Per-entry re-asks run this many git processes at once. */
const VERIFY_CONCURRENCY = 8;

/** Parse one record (the text between two \x1e) into its commit and paths. */
export function parseLogRecord(record: string): { commit: EntryCommit; paths: string[] } | null {
  const headerEnd = record.indexOf("\0");
  const header = headerEnd < 0 ? record : record.slice(0, headerEnd);
  const [sha, date, ...subject] = header.split("\x1f");
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const rest = headerEnd < 0 ? "" : record.slice(headerEnd + 1).replace(/^\n/, "");
  const paths = rest.split("\0").filter(Boolean);
  return { commit: { sha, date: date ?? "", subject: subject.join("\x1f") }, paths };
}

/** The entry of `dir` that `path` falls under, or null when it is outside `dir`. */
export function entryFor(dir: string, path: string): string | null {
  const prefix = dir ? `${dir}/` : "";
  if (prefix && !path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Walk history from `sha`, crediting changed paths to `names`; stop when all
 * are credited. `firstMerge` is the newest merge on the tip's line: `--sparse`
 * makes git show every commit it walks, that merge included, and any entry
 * credited once the walk has reached it is returned in `uncertain`.
 */
function walk(
  storageKey: string,
  sha: string,
  dir: string,
  names: Set<string>,
  firstMerge: string | null,
): Promise<{ commits: Record<string, EntryCommit>; uncertain: Set<string> }> {
  const commits: Record<string, EntryCommit> = {};
  const uncertain = new Set<string>();
  let found = 0;
  let pastMerge = false;
  if (names.size === 0) return Promise.resolve({ commits, uncertain });

  const args = [
    "--literal-pathspecs", "log", "--sparse", "-z", "--name-only",
    `--format=${LOG_FORMAT}`, `--max-count=${MAX_WALK}`, sha,
  ];
  // The entries themselves, when there aren't too many: simplification then
  // follows the history of exactly what is listed.
  if (names.size <= MAX_PATHSPECS) args.push("--", ...[...names].map((n) => join(dir, n)));
  else if (dir) args.push("--", dir);

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: bareRepoPathFromKey(storageKey), stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ commits, uncertain });
    };
    const take = (record: string) => {
      const parsed = parseLogRecord(record);
      if (!parsed) return;
      if (parsed.commit.sha === firstMerge) pastMerge = true;
      for (const p of parsed.paths) {
        const name = entryFor(dir, p);
        if (name !== null && names.has(name) && !commits[name]) {
          commits[name] = parsed.commit;
          if (pastMerge) uncertain.add(name);
          found++;
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      // Every record but the last is complete once the next one has begun.
      const records = buffer.split("\x1e");
      buffer = records.pop() ?? "";
      for (const r of records) if (r) take(r);
      if (found === names.size) {
        child.kill();
        finish();
      }
    });
    child.on("error", (err) => { if (!done) { done = true; reject(err); } });
    child.on("close", () => {
      if (!done && buffer) take(buffer);
      finish();
    });
  });
}

/** Per-entry re-asks made so far — lets tests see a linear history needs none. */
export let __verifications = 0;

/** `git log -1 <sha> -- <path>`: the reference answer the walk stands in for. */
async function lastCommitFor(storageKey: string, sha: string, path: string): Promise<EntryCommit | null> {
  __verifications++;
  const out = await git(storageKey, ["--literal-pathspecs", "log", "-1", "-z", `--format=${LOG_FORMAT}`, sha, "--", path]);
  return out ? (parseLogRecord(out.replace(/^\x1e/, ""))?.commit ?? null) : null;
}

/** Run `fn` over `items`, `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const cache = new Map<string, TreeCommits>();
const CACHE_LIMIT = 1000;

export function __resetTreeCommitsCache(): void {
  cache.clear();
}

/**
 * The last commit per entry of `dirPath` at `ref` (default branch when
 * omitted), or null when the ref does not resolve. Cached per (commit, path):
 * both are immutable.
 */
export async function getTreeCommits(storageKey: string, dirPath: string, ref?: string): Promise<TreeCommits | null> {
  const name = ref ?? (await defaultBranch(storageKey));
  if (!name || name.startsWith("-")) return null;
  const sha = await resolveRefSha(storageKey, name);
  if (!sha) return null;
  const dir = dirPath.replace(/^\/+|\/+$/g, "");

  const key = `${storageKey}@${sha}:${dir}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, ref: name };

  const [entries, count, firstMerge] = await Promise.all([
    listTree(storageKey, sha, dir),
    git(storageKey, ["rev-list", "--count", sha]),
    git(storageKey, ["rev-list", "--merges", "--first-parent", "-1", sha]),
  ]);
  const names = new Set(entries.map((e) => e.name));
  const { commits, uncertain } = await walk(storageKey, sha, dir, names, firstMerge || null);
  await inBatches([...uncertain], VERIFY_CONCURRENCY, async (entry) => {
    const exact = await lastCommitFor(storageKey, sha, join(dir, entry));
    if (exact) commits[entry] = exact;
    else delete commits[entry];
  });
  const complete = Object.keys(commits).length === names.size;
  const result: TreeCommits = { ref: name, sha, path: dir, commits, complete, totalCommits: Number(count) || 0 };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}
