import type { RepoMember } from "../../../api";
import type { RequestedReviewer, ReviewSummary, ReviewerSummary } from "../../../types";

/**
 * Pure view-model for the PR reviewers sidebar (issue #82): merges the
 * server-computed review summary (who actually reviewed, issue #81) with the
 * requested-reviewer state into one row per person, and filters the member list
 * for the "request a review" picker. Kept free of React so it unit-tests like
 * mergeMethods.ts.
 */

export type ReviewerRow = {
  handle: string;
  /** Latest submitted review, when they have one (drives the verdict icon). */
  review: ReviewerSummary | null;
  /** Active request pointing at them, when one exists. */
  request: RequestedReviewer | null;
};

/**
 * One row per person, requested-but-silent reviewers first (oldest request
 * first, so the list is stable as requests are added), then everyone else who
 * reviewed, in the summary's own newest-first order. A person who was requested
 * AND reviewed collapses into a single row carrying both facts.
 */
export function buildReviewerRows(
  summary: ReviewSummary | undefined,
  requested: RequestedReviewer[] | undefined,
): ReviewerRow[] {
  const reviews = new Map<string, ReviewerSummary>((summary?.reviewers ?? []).map((r) => [r.author, r]));
  const rows: ReviewerRow[] = [];
  const seen = new Set<string>();

  const requests = [...(requested ?? [])].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  for (const req of requests) {
    rows.push({ handle: req.handle, review: reviews.get(req.handle) ?? null, request: req });
    seen.add(req.handle);
  }
  for (const review of summary?.reviewers ?? []) {
    if (seen.has(review.author)) continue;
    rows.push({ handle: review.author, review, request: null });
  }
  return rows;
}

/**
 * Members offered by the "request a review" picker: everyone with repo access
 * except the PR author (can't review their own PR), the viewer (no
 * self-requests), and anyone with a still-pending request (re-request lives on
 * their row instead). Owners first, then writers, then readers, A→Z within.
 */
export function requestableMembers(
  members: RepoMember[],
  opts: { author: string; currentUser: string; requested: RequestedReviewer[] },
): RepoMember[] {
  const pending = new Set(opts.requested.filter((r) => r.state === "requested").map((r) => r.handle));
  const rank = { owner: 0, writer: 1, reader: 2 } as const;
  return members
    .filter((m) => m.handle !== opts.author && m.handle !== opts.currentUser && !pending.has(m.handle))
    .sort((a, b) => rank[a.role] - rank[b.role] || a.handle.localeCompare(b.handle));
}
