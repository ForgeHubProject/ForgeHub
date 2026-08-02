import { prisma } from "./prisma.js";
import {
  listMergeBaseCommits,
  performMerge,
  performRebaseMerge,
  performSquashMerge,
  resolveBranchSha,
  type CommitAuthor,
  type MergeMethod,
} from "./git-utils.js";
import { recordEvent } from "./timeline-service.js";
import { emitRepoEvent } from "./webhook-service.js";
import { closeIssuesForMergedPull } from "./references-service.js";
import { ingestCommitRange } from "./ingest.js";
import { bareRepoPathFromKey } from "./git-storage.js";
import { emitPushEvents, ZERO_SHA } from "./push-events.js";

/**
 * The merge EXECUTION shared by the merge endpoint and auto-merge (issue #119):
 * run the chosen strategy, persist the MERGED state, and fan out every
 * merge side effect (timeline, webhooks, push events + CI, issue closing,
 * ingestion). Gating (branch protection, the soft review gate) deliberately
 * stays with the callers — the endpoint answers an interactive request with
 * override semantics, while auto-merge re-evaluates its own gates — so this
 * function assumes the caller has already decided the merge may happen.
 */

/** Minimal logger surface so app-less callers (the CI runner path) can pass none. */
type LogLike = { error: (obj: unknown, msg?: string) => void };

export type PullMergeInput = {
  repo: { id: string; storageKey: string };
  pr: { id: string; number: number; title: string; fromBranch: string; toBranch: string };
  /** The user the merge is performed AS (squash author, timeline actor, webhook sender). */
  actorId: string;
  mergeMethod: MergeMethod;
  commitMessage?: string;
  /** Marks the timeline/webhook payload as an auto-merge firing. */
  auto?: boolean;
  log?: LogLike;
};

export type PullMergeOutcome =
  | { status: "merged"; sha: string }
  | { status: "conflict" }
  | { status: "alreadyMerged" }
  | { status: "error" };

/** Resolve the git author identity for a user performing a merge/revert. */
export async function resolveActorIdentity(userId: string): Promise<CommitAuthor> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { handle: true, displayName: true, email: true },
  });
  const name = user?.displayName?.trim() || user?.handle || "ForgeHub";
  const email = user?.email || "merge@forgehub.io";
  return { name, email };
}

export async function executePullMerge(input: PullMergeInput): Promise<PullMergeOutcome> {
  const { repo, pr, actorId, mergeMethod, auto } = input;
  const message =
    input.commitMessage?.trim() || `Merge '${pr.fromBranch}' into '${pr.toBranch}' (#${pr.number})`;

  // Capture the toBranch SHA before merge for the ingestion range + push event.
  const beforeSha = await resolveBranchSha(repo.storageKey, pr.toBranch);

  let result: Awaited<ReturnType<typeof performMerge>>;
  try {
    if (mergeMethod === "squash") {
      // Single squashed commit authored as the merger: "<title> (!N)" + subjects.
      const prCommits = await listMergeBaseCommits(repo.storageKey, pr.toBranch, pr.fromBranch);
      const subjects = prCommits.map((c) => `* ${c.subject}`).join("\n");
      const subject = input.commitMessage?.trim() || `${pr.title} (!${pr.number})`;
      const squashMessage = subjects ? `${subject}\n\n${subjects}\n` : `${subject}\n`;
      const author = await resolveActorIdentity(actorId);
      result = await performSquashMerge(repo.storageKey, pr.fromBranch, pr.toBranch, squashMessage, author);
    } else if (mergeMethod === "rebase") {
      result = await performRebaseMerge(repo.storageKey, pr.fromBranch, pr.toBranch);
    } else {
      result = await performMerge(repo.storageKey, pr.fromBranch, pr.toBranch, message);
    }
  } catch (err) {
    input.log?.error({ err }, "merge threw unexpectedly");
    return { status: "error" };
  }

  if (!result.ok) {
    return "alreadyMerged" in result ? { status: "alreadyMerged" } : { status: "conflict" };
  }

  await prisma.pullRequest.update({
    where: { id: pr.id },
    data: { state: "MERGED", mergedAt: new Date(), mergeMethod, mergeCommitSha: result.sha },
  });

  await recordEvent({
    repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
    kind: "merged", actorId,
    data: { sha: result.sha, ...(auto ? { auto: true } : {}) },
  }).catch((err) => input.log?.error({ err }, "recordEvent merged"));
  void emitRepoEvent({
    repoId: repo.id, event: "pull_request", action: "merged", senderId: actorId,
    subject: {
      number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch,
      state: "merged", mergeCommitSha: result.sha, ...(auto ? { auto: true } : {}),
    },
  });
  // The target branch tip moved via a direct-to-bare merge push (which sets
  // FORGEHUB_INTERNAL_PUSH=1 and so bypasses the git-http post-receive path):
  // fire the same `push` webhook + push CI a client push to `toBranch` would,
  // so a merge commit isn't invisible to hooks/CI (issues #86/#87).
  emitPushEvents(repo.id, repo.storageKey, actorId, [
    { branch: pr.toBranch, oldSha: beforeSha ?? ZERO_SHA, newSha: result.sha },
  ]);
  await closeIssuesForMergedPull({ repoId: repo.id, prId: pr.id, prNumber: pr.number, mergerId: actorId })
    .catch((err) => input.log?.error({ err }, "closeIssuesForMergedPull"));

  // Fire-and-forget: ingest any new .gltf files introduced by the merge
  if (beforeSha && result.sha) {
    const repoPath = bareRepoPathFromKey(repo.storageKey);
    const repoId = repo.id;
    const afterSha = result.sha;
    setImmediate(() => {
      ingestCommitRange(repoId, repoPath, beforeSha, afterSha).catch(() => {});
    });
  }

  return { status: "merged", sha: result.sha };
}
