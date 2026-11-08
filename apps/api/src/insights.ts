import { defaultBranch, git, resolveRefSha } from "./git-utils.js";

/**
 * A repository's Insights (#256), from its history at one commit: weekly
 * commits, additions and deletions, each author's share, and the last year's
 * commits by weekday. Merge commits are left out, as for contributors (#209).
 */

export type InsightsWeek = { week: string; commits: number; additions: number; deletions: number };
export type InsightsAuthor = {
  email: string;
  name: string;
  commits: number;
  additions: number;
  deletions: number;
  /** Commits per week, keyed by the week's Sunday (YYYY-MM-DD). */
  weeks: Record<string, number>;
};
export type Insights = {
  ref: string;
  sha: string;
  /** Contiguous weeks, oldest first, from the first commit (at most 156 weeks back) to this week. */
  weeks: InsightsWeek[];
  authors: InsightsAuthor[];
  /** The last 52 weeks' commits by weekday, Sunday first; each row lines up with the tail of `weeks`. */
  days: number[][];
  /** Commits read; history past MAX_COMMITS is left out. */
  scanned: number;
  truncated: boolean;
};

const MAX_COMMITS = 20_000;
const MAX_WEEKS = 156;
const DAY = 86_400_000;

/** The Sunday (UTC) of the week a time falls in. */
export function weekOf(ms: number): string {
  const d = new Date(ms);
  const sunday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * DAY;
  return new Date(sunday).toISOString().slice(0, 10);
}

type Commit = { at: number; name: string; email: string; additions: number; deletions: number };

/** Parse `git log --format=%x00%at%x09%aN%x09%aE --numstat`. Binary files count no lines. */
export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of out.split("\0")) {
    if (!chunk.trim()) continue;
    const [header, ...lines] = chunk.split("\n");
    const [at, name, email] = header.split("\t");
    const c: Commit = { at: Number(at) * 1000, name: (name ?? "").trim(), email: (email ?? "").trim().toLowerCase(), additions: 0, deletions: 0 };
    if (!Number.isFinite(c.at)) continue;
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      if (m[1] !== "-") c.additions += Number(m[1]);
      if (m[2] !== "-") c.deletions += Number(m[2]);
    }
    commits.push(c);
  }
  return commits;
}

/** Bucket commits into weeks, authors and weekdays; `now` sets "this week". */
export function summarize(commits: Commit[], now = Date.now()): Omit<Insights, "ref" | "sha" | "scanned" | "truncated"> {
  const thisWeek = Date.parse(weekOf(now));
  const firstAt = commits.reduce((min, c) => Math.min(min, c.at), Infinity);
  const start = Number.isFinite(firstAt) ? Math.max(Date.parse(weekOf(firstAt)), thisWeek - (MAX_WEEKS - 1) * 7 * DAY) : thisWeek;
  const weeks = new Map<string, InsightsWeek>();
  for (let t = start; t <= thisWeek; t += 7 * DAY) {
    const week = new Date(t).toISOString().slice(0, 10);
    weeks.set(week, { week, commits: 0, additions: 0, deletions: 0 });
  }
  const yearStart = thisWeek - 51 * 7 * DAY;
  const days = Array.from({ length: 52 }, () => [0, 0, 0, 0, 0, 0, 0]);
  const authors = new Map<string, InsightsAuthor & { names: Map<string, number> }>();

  for (const c of commits) {
    const week = weekOf(c.at);
    const w = weeks.get(week);
    if (w) {
      w.commits++;
      w.additions += c.additions;
      w.deletions += c.deletions;
    }
    const weekStart = Date.parse(week);
    if (weekStart >= yearStart && weekStart <= thisWeek) days[(weekStart - yearStart) / (7 * DAY)][new Date(c.at).getUTCDay()]++;
    const key = c.email || c.name;
    const a = authors.get(key) ?? { email: c.email, name: c.name, commits: 0, additions: 0, deletions: 0, weeks: {} as Record<string, number>, names: new Map<string, number>() };
    a.commits++;
    a.additions += c.additions;
    a.deletions += c.deletions;
    if (w) a.weeks[week] = (a.weeks[week] ?? 0) + 1;
    a.names.set(c.name, (a.names.get(c.name) ?? 0) + 1);
    authors.set(key, a);
  }

  return {
    weeks: [...weeks.values()],
    days,
    authors: [...authors.values()]
      .map(({ names, ...a }) => ({ ...a, name: [...names].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] || a.email }))
      .sort((x, y) => y.commits - x.commits || x.name.localeCompare(y.name)),
  };
}

const cache = new Map<string, Omit<Insights, "ref">>();
const CACHE_LIMIT = 200;

/** Insights at `ref` (the default branch when omitted); null for an empty repository or an unknown ref. */
export async function getInsights(storageKey: string, ref?: string): Promise<Insights | null> {
  const name = ref ?? (await defaultBranch(storageKey));
  if (!name || name.startsWith("-")) return null;
  const sha = await resolveRefSha(storageKey, name);
  if (!sha) return null;
  // Weeks run to "now", so a cached answer is good for the day it was made.
  const key = `${storageKey}@${sha}@${new Date().toISOString().slice(0, 10)}`;
  let result = cache.get(key);
  if (!result) {
    const out = await git(storageKey, ["log", "--no-merges", `-n${MAX_COMMITS}`, "--format=%x00%at%x09%aN%x09%aE", "--numstat", sha]);
    const commits = parseLog(out);
    result = { sha, ...summarize(commits), scanned: commits.length, truncated: commits.length >= MAX_COMMITS };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, result);
  }
  return { ref: name, ...result };
}
