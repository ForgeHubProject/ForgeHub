import { prisma } from "./prisma.js";
import { listChangedPaths } from "./git-utils.js";
import { ZERO_SHA } from "./push-events.js";

/**
 * Per-user "Viewed" bookkeeping on a PR's files view (issue #119). The state
 * lives in `PullRequestFileView` rows; this module owns the RESET rule: when a
 * PR's head branch moves, every file the push actually changed drops back to
 * unviewed for everyone — a viewed tick only ever vouches for the version of
 * the file it was ticked on. Called from the shared post-receive effects (both
 * git transports) and from the apply-suggestion internal push.
 */

/** A branch tip that moved during a push (same shape push-events uses). */
type ChangedRef = { branch: string; oldSha: string; newSha: string };

export async function resetViewedFilesForPush(
  repoId: string,
  storageKey: string,
  changed: ChangedRef[],
): Promise<void> {
  if (changed.length === 0) return;
  const byBranch = new Map(changed.map((c) => [c.branch, c]));

  const openPrs = await prisma.pullRequest.findMany({
    where: { repoId, state: "OPEN", fromBranch: { in: [...byBranch.keys()] } },
    select: { id: true, fromBranch: true },
  });

  for (const pr of openPrs) {
    const change = byBranch.get(pr.fromBranch);
    if (!change) continue;
    if (change.oldSha === ZERO_SHA) {
      // Branch (re)created — no diffable range, so conservatively reset everything.
      await prisma.pullRequestFileView.deleteMany({ where: { pullRequestId: pr.id } });
      continue;
    }
    const paths = await listChangedPaths(storageKey, change.oldSha, change.newSha);
    if (paths.length === 0) continue;
    await prisma.pullRequestFileView.deleteMany({
      where: { pullRequestId: pr.id, filePath: { in: paths } },
    });
  }
}
