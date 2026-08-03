import { loadCodeowners, ownersForPaths } from "./codeowners.js";
import { getMergeBaseFileList } from "./git-utils.js";
import { notifyUser } from "./notifications-service.js";
import { prisma } from "./prisma.js";
import { recordEvent } from "./timeline-service.js";

/**
 * Auto reviewer-requests from CODEOWNERS (issue #89), reusing the
 * `PullRequestReviewerRequest` + `REVIEW_REQUESTED` plumbing of issue #82.
 *
 * Runs on PR creation and again whenever a PR's head branch is pushed, since a
 * new commit can touch newly-owned paths. CODEOWNERS is read from the PR's BASE
 * branch — the branch that will receive the changes decides who guards it, so a
 * PR can't hand itself new owners (or delete the existing ones) from its head.
 *
 * Eligibility mirrors what `POST …/requested-reviewers` enforces, so an
 * automatic request can never manufacture one a person couldn't have made:
 *   - the reviewer must be the repo owner or a direct collaborator (any role),
 *   - never the PR author (nobody reviews their own PR),
 *   - never the acting user (the request is recorded as coming from them, and
 *     #82 rejects self-requests).
 * Owners failing any of these are skipped SILENTLY — CODEOWNERS naming a
 * stranger is a repo-config smell, not a reason to fail PR creation.
 *
 * Existing rows are left completely alone: a request that was withdrawn or
 * already fulfilled is never revived, so automation cannot undo a human's
 * decision. Only a genuinely absent (PR, reviewer) pair produces a new row.
 */

/** The repo slice the eligibility check needs. */
type CodeownersRepo = {
  id: string;
  storageKey: string;
  ownerId: string;
  collaborators: Array<{ userId: string }>;
};

/** The PR slice the request path needs. */
type CodeownersPull = {
  id: string;
  number: number;
  title: string;
  fromBranch: string;
  toBranch: string;
  authorId: string;
};

/**
 * Resolve the CODEOWNERS owners of a PR's changed files to eligible user rows.
 * Empty when the repo has no CODEOWNERS, nothing matches, or no matched handle
 * clears the eligibility bar.
 */
async function eligibleOwners(
  repo: CodeownersRepo,
  pr: CodeownersPull,
  actorId: string,
): Promise<Array<{ id: string; handle: string }>> {
  const rules = await loadCodeowners(repo.storageKey, pr.toBranch);
  if (rules.length === 0) return [];

  const files = await getMergeBaseFileList(repo.storageKey, pr.toBranch, pr.fromBranch);
  const handles = ownersForPaths(rules, files.map((f) => f.path));
  if (handles.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { handle: { in: handles } },
    select: { id: true, handle: true },
  });
  const allowed = new Set([repo.ownerId, ...repo.collaborators.map((c) => c.userId)]);
  return users.filter((u) => u.id !== pr.authorId && u.id !== actorId && allowed.has(u.id));
}

/**
 * Request every eligible CODEOWNERS owner of `pr` that isn't already tracked.
 * Best-effort and idempotent — safe to re-run on every push. Returns the handles
 * newly requested (empty when there was nothing to do).
 */
export async function applyCodeownersReviewers(
  repo: CodeownersRepo,
  pr: CodeownersPull,
  actorId: string,
): Promise<string[]> {
  const owners = await eligibleOwners(repo, pr, actorId);
  if (owners.length === 0) return [];

  const requested: string[] = [];
  for (const owner of owners) {
    const existing = await prisma.pullRequestReviewerRequest.findUnique({
      where: { pullRequestId_userId: { pullRequestId: pr.id, userId: owner.id } },
    });
    if (existing) continue; // pending, fulfilled or withdrawn — all mean "hands off"

    try {
      await prisma.pullRequestReviewerRequest.create({
        data: { pullRequestId: pr.id, userId: owner.id, requestedById: actorId, viaCodeowners: true },
      });
    } catch {
      continue; // lost a race on @@unique([pullRequestId, userId]) — someone else asked first
    }

    requested.push(owner.handle);
    void notifyUser(owner.id, {
      actorId, repoId: repo.id, subjectType: "PULL_REQUEST",
      subjectId: pr.id, subjectTitle: pr.title, reason: "REVIEW_REQUESTED",
    });
    await recordEvent({
      repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
      kind: "review_requested", actorId, data: { reviewer: owner.handle, viaCodeowners: true },
    }).catch(() => { /* timeline is a side effect; never fail the PR over it */ });
  }

  return requested;
}

/**
 * Post-push hook: re-run the CODEOWNERS match for every OPEN pull request whose
 * head branch just moved. Loads each PR's repo slice once, then delegates.
 * Swallows its own failures — a push must not fail over reviewer bookkeeping.
 */
export async function syncCodeownersReviewersForPush(
  repoId: string,
  actorId: string,
  changed: Array<{ branch: string }>,
): Promise<void> {
  if (changed.length === 0) return;
  const branches = [...new Set(changed.map((c) => c.branch))];

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { id: true, storageKey: true, ownerId: true, collaborators: { select: { userId: true } } },
  });
  if (!repo?.storageKey) return;

  const openPrs = await prisma.pullRequest.findMany({
    where: { repoId, state: "OPEN", fromBranch: { in: branches } },
    select: { id: true, number: true, title: true, fromBranch: true, toBranch: true, authorId: true },
  });

  for (const pr of openPrs) {
    await applyCodeownersReviewers({ ...repo, storageKey: repo.storageKey }, pr, actorId);
  }
}
