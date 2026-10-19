import { git } from "./git-utils.js";

/**
 * The two commits a pull request's files, diffs and commits are between: the
 * merge base it branched from, and its head.
 *
 * While a PR is open these are read live from its branches. Once it is merged
 * that no longer works: the base branch then contains the head, so the merge
 * base IS the head and every view of the PR came out empty ("0 files changed",
 * no commits). So the range is recorded when the PR is merged or closed
 * (`baseSha` / `headSha`), and for PRs merged before that, derived from the
 * merge commit.
 */
export type PullRange = { base: string; head: string };

type PullLike = {
  state: string;
  fromBranch: string;
  toBranch: string;
  baseSha?: string | null;
  headSha?: string | null;
  mergeCommitSha?: string | null;
  mergeMethod?: string | null;
};

async function tryGit(storageKey: string, args: string[]): Promise<string | null> {
  try {
    return (await git(storageKey, args)).trim() || null;
  } catch {
    return null;
  }
}

/** The range as the branches stand now — what an open PR shows. */
export async function liveRange(storageKey: string, toBranch: string, fromBranch: string): Promise<PullRange | null> {
  const [base, head] = await Promise.all([
    tryGit(storageKey, ["merge-base", toBranch, fromBranch]),
    tryGit(storageKey, ["rev-parse", "--verify", "--quiet", `${fromBranch}^{commit}`]),
  ]);
  return base && head ? { base, head } : null;
}

/**
 * The range of a PR merged before ranges were recorded, from its merge commit.
 * A merge commit's second parent is the head that was merged, and its merge
 * base with the first parent is where the PR began. A squash is one commit on
 * the base branch, so its range is that commit against its parent. A rebase
 * replays the PR's commits; when the source branch still has them, their count
 * says how far back the base is — else the last commit is all that can be named.
 */
async function mergedRange(storageKey: string, pr: PullLike): Promise<PullRange | null> {
  const merge = pr.mergeCommitSha;
  if (!merge) return null;
  const line = await tryGit(storageKey, ["rev-list", "--parents", "-n", "1", merge]);
  if (!line) return null;
  const [, first, second] = line.split(" ");
  if (!first) return null;
  if (second) {
    const base = await tryGit(storageKey, ["merge-base", first, second]);
    return base ? { base, head: second } : null;
  }
  if (pr.mergeMethod === "rebase") {
    const from = await tryGit(storageKey, ["merge-base", merge, pr.fromBranch]);
    const count = from ? await tryGit(storageKey, ["rev-list", "--count", `${from}..${pr.fromBranch}`]) : null;
    const n = count ? Number(count) : 0;
    if (n > 0) {
      const base = await tryGit(storageKey, ["rev-parse", "--verify", "--quiet", `${merge}~${n}^{commit}`]);
      if (base) return { base, head: merge };
    }
  }
  return { base: first, head: merge };
}

/** The range a PR's views should show, whatever state it is in. Null when it can't be named. */
export async function pullRange(storageKey: string, pr: PullLike): Promise<PullRange | null> {
  if (pr.baseSha && pr.headSha) return { base: pr.baseSha, head: pr.headSha };
  if (pr.state === "MERGED") {
    const merged = await mergedRange(storageKey, pr);
    if (merged) return merged;
  }
  return liveRange(storageKey, pr.toBranch, pr.fromBranch);
}
