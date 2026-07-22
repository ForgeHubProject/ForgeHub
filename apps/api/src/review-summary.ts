import { prisma } from "./prisma.js";

/**
 * Server-computed review status for a pull request. The merge box renders the
 * summary line ("2 approvals · 1 change requested") and the merge gate keys off
 * `changesRequested` (non-stale CHANGES_REQUESTED reviews). Staleness is derived
 * by comparing each review's recorded `commitSha` to the PR head's current SHA —
 * a review left before a push drops out of the approval/changes counts.
 */

export type ReviewVerdict = "approved" | "changes_requested" | "commented";

export type ReviewerSummary = {
  author: string;
  state: ReviewVerdict;
  stale: boolean;
  submittedAt: string | null;
  /** Head SHA the review was left against; null for legacy rows with no record. */
  commitSha: string | null;
};

export type ReviewSummary = {
  /** Latest submitted review per reviewer, newest first. */
  reviewers: ReviewerSummary[];
  approvals: number;
  changesRequested: number;
  commented: number;
  staleCount: number;
  /** Unresolved root threads across submitted reviews. */
  unresolvedThreads: number;
};

/**
 * A submitted review is stale when it was left against a head SHA that no longer
 * matches the PR head. Rows with no recorded SHA (legacy) are never stale, and a
 * null current head (no git storage) can't stale anything.
 */
export function isReviewStale(
  reviewSha: string | null | undefined,
  headSha: string | null | undefined,
): boolean {
  return !!reviewSha && !!headSha && reviewSha !== headSha;
}

const EMPTY_SUMMARY: ReviewSummary = {
  reviewers: [],
  approvals: 0,
  changesRequested: 0,
  commented: 0,
  staleCount: 0,
  unresolvedThreads: 0,
};

/**
 * Compute the review summary for a PR. `headSha` is the current head SHA (null
 * when the repo has no git storage / the branch can't be resolved).
 */
export async function computeReviewSummary(
  pullRequestId: string,
  headSha: string | null,
): Promise<ReviewSummary> {
  const submitted = await prisma.pullRequestReview.findMany({
    where: { pullRequestId, state: { not: "PENDING" }, submittedAt: { not: null } },
    orderBy: { submittedAt: "asc" },
    include: { author: { select: { handle: true } } },
  });

  // Latest submitted review per author (asc order → last write wins).
  const latestByAuthor = new Map<string, (typeof submitted)[number]>();
  for (const r of submitted) latestByAuthor.set(r.authorId, r);

  const reviewers: ReviewerSummary[] = [...latestByAuthor.values()]
    .map((r) => ({
      author: r.author.handle,
      state: r.state.toLowerCase() as ReviewVerdict,
      stale: isReviewStale(r.commitSha, headSha),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      commitSha: r.commitSha ?? null,
    }))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")).reverse();

  const approvals = reviewers.filter((r) => r.state === "approved" && !r.stale).length;
  const changesRequested = reviewers.filter((r) => r.state === "changes_requested" && !r.stale).length;
  const commented = reviewers.filter((r) => r.state === "commented").length;
  const staleCount = reviewers.filter((r) => r.stale).length;

  const unresolvedRoots = await prisma.pullRequestReviewComment.findMany({
    where: {
      pullRequestId,
      inReplyToId: null,
      resolvedAt: null,
      review: { state: { not: "PENDING" } },
    },
    select: { id: true },
  });

  return {
    reviewers,
    approvals,
    changesRequested,
    commented,
    staleCount,
    unresolvedThreads: unresolvedRoots.length,
  };
}

/** Defensive default when no PR context is available. */
export function emptyReviewSummary(): ReviewSummary {
  return { ...EMPTY_SUMMARY, reviewers: [] };
}
