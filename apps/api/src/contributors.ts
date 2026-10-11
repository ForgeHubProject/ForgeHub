import { defaultBranch, git, resolveRefSha } from "./git-utils.js";

/**
 * Who has committed to a repository, for the Code tab's sidebar (issue #209).
 *
 * The tally comes from `git shortlog -sne --no-merges` at a resolved commit, so
 * it honours `.mailmap` and leaves out merge commits — ForgeHub writes one per
 * merged pull request, and counting those would credit whoever clicked merge
 * with everyone's work. A commit is immutable, so the tally is cached per sha;
 * which authors link to an account is decided per request by the route, because
 * that depends on who can push today.
 */

export type AuthorTally = {
  /** Lowercased author email — the identity commits are grouped by. */
  email: string;
  /** The name this email committed under most often. */
  name: string;
  commits: number;
};

/**
 * Parse `git shortlog -sne` output ("   12\tName <email>") into one tally per
 * email, most commits first. shortlog groups by name AND email, so one person
 * who changed how their name is spelled shows up twice; folding by email keeps
 * them one contributor, under the name they used most.
 */
export function tallyShortlog(out: string): AuthorTally[] {
  const byEmail = new Map<string, { names: Map<string, number>; commits: number }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\t(.*?)\s*<([^>]*)>\s*$/.exec(line);
    if (!m) continue;
    const commits = Number(m[1]);
    const name = m[2].trim();
    const email = m[3].trim().toLowerCase();
    const entry = byEmail.get(email) ?? { names: new Map<string, number>(), commits: 0 };
    entry.commits += commits;
    entry.names.set(name, (entry.names.get(name) ?? 0) + commits);
    byEmail.set(email, entry);
  }
  const tallies: AuthorTally[] = [];
  for (const [email, { names, commits }] of byEmail) {
    const name = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    tallies.push({ email, name: name || email, commits });
  }
  return tallies.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

const cache = new Map<string, AuthorTally[]>();
const CACHE_LIMIT = 500;

export function __resetContributorsCache(): void {
  cache.clear();
}

/**
 * The author tallies at `ref` (default branch when omitted), or null when the
 * ref doesn't resolve — an empty repository, or a name that isn't a ref.
 */
export async function getAuthorTallies(
  storageKey: string,
  ref?: string,
): Promise<{ ref: string; sha: string; tallies: AuthorTally[] } | null> {
  const name = ref ?? (await defaultBranch(storageKey));
  // A ref is handed to git as an argument; one that looks like an option is not
  // a ref anyone has.
  if (!name || name.startsWith("-")) return null;
  const sha = await resolveRefSha(storageKey, name);
  if (!sha) return null;

  const key = `${storageKey}@${sha}`;
  let tallies = cache.get(key);
  if (!tallies) {
    tallies = tallyShortlog(await git(storageKey, ["shortlog", "-sne", "--no-merges", sha]));
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, tallies);
  }
  return { ref: name, sha, tallies };
}
