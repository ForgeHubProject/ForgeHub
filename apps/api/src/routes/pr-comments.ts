import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { notifyUser } from "../notifications-service.js";
import { syncBodyReferences } from "../references-service.js";
import { parseQuickActions, applyQuickActions } from "../quick-actions.js";
import { recordEvent, emitHeadPushedForPush } from "../timeline-service.js";
import { commitFileToBranch, readFileAtBranchExact, resolveBranchSha } from "../git-utils.js";
import { isReviewStale } from "../review-summary.js";
import { maybeAutoMergePr } from "../auto-merge.js";
import { applySuggestionToContent } from "../suggestions.js";
import { resolveActorIdentity } from "../pull-merge.js";
import { emitPushEvents, ZERO_SHA } from "../push-events.js";
import { triggerWorkflowsForPrSync } from "../ci/trigger.js";
import { resetViewedFilesForPush } from "../pull-file-views.js";
import { ingestCommitRange } from "../ingest.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import { deleteSubjectReactions, reactionRollupFor, reactionRollups, type ReactionRollup } from "../reactions-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPRComment(comment: {
  id: string;
  body: string;
  author: { handle: string };
  createdAt: Date;
  updatedAt: Date;
}, rollup?: ReactionRollup) {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.author.handle,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    // Emoji reactions (#90) — empty when no rollup was fetched (new comments).
    reactions: rollup?.reactions ?? {},
    viewerReacted: rollup?.viewerReacted ?? [],
  };
}

function formatReview(
  review: {
    id: string;
    state: string;
    body: string | null;
    author: { handle: string };
    submittedAt: Date | null;
    commitSha?: string | null;
    createdAt: Date;
    updatedAt: Date;
    _count?: { comments: number };
  },
  opts?: { commentCount?: number; currentHeadSha?: string | null },
) {
  return {
    id: review.id,
    state: review.state.toLowerCase(),
    body: review.body,
    author: review.author.handle,
    submittedAt: review.submittedAt?.toISOString() ?? null,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    commentCount: opts?.commentCount ?? review._count?.comments ?? 0,
    commitSha: review.commitSha ?? null,
    stale: isReviewStale(review.commitSha, opts?.currentHeadSha ?? null),
  };
}

function formatReviewComment(comment: {
  id: string;
  reviewId: string;
  body: string;
  author: { handle: string };
  filePath: string;
  position: string;
  inReplyToId?: string | null;
  resolvedAt?: Date | null;
  resolvedBy?: { handle: string } | null;
  review?: { state: string } | null;
  suggestion?: string | null;
  suggestionAppliedAt?: Date | null;
  suggestionCommitSha?: string | null;
  createdAt: Date;
  updatedAt: Date;
}, rollup?: ReactionRollup) {
  return {
    id: comment.id,
    reviewId: comment.reviewId,
    body: comment.body,
    author: comment.author.handle,
    filePath: comment.filePath,
    position: JSON.parse(comment.position) as unknown,
    inReplyToId: comment.inReplyToId ?? null,
    resolved: comment.resolvedAt != null,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    resolvedBy: comment.resolvedBy?.handle ?? null,
    pending: comment.review ? comment.review.state === "PENDING" : false,
    // Suggested change (issue #119): the replacement text plus applied state.
    suggestion: comment.suggestion ?? null,
    suggestionApplied: comment.suggestionAppliedAt != null,
    suggestionCommitSha: comment.suggestionCommitSha ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    // Emoji reactions (#90) — empty when no rollup was fetched (new comments).
    reactions: rollup?.reactions ?? {},
    viewerReacted: rollup?.viewerReacted ?? [],
  };
}

/**
 * Validate an optional suggested-change payload against the comment's position
 * (issue #119). A suggestion replaces the anchored line at the PR head, so it
 * only makes sense on a text-position comment anchored to the `incoming` side —
 * a base-side (deleted) line no longer exists at head to be replaced.
 */
function validateSuggestion(
  suggestion: unknown,
  position: { type?: unknown; side?: unknown },
): { valid: true; value: string | null } | { valid: false; error: string } {
  if (suggestion === undefined || suggestion === null) return { valid: true, value: null };
  if (typeof suggestion !== "string") {
    return { valid: false, error: "suggestion must be a string" };
  }
  if (position.type !== "text") {
    return { valid: false, error: "suggestion requires a text position" };
  }
  if (position.side !== "incoming") {
    return { valid: false, error: "suggestion requires an incoming-side text position (the line must exist at the PR head)" };
  }
  return { valid: true, value: suggestion };
}

type PositionPayload = Record<string, unknown>;

function validatePosition(position: unknown): { valid: true; serialized: string } | { valid: false; error: string } {
  if (typeof position !== "object" || position === null || Array.isArray(position)) {
    return { valid: false, error: "position must be an object" };
  }
  const pos = position as PositionPayload;
  const type = pos["type"];
  if (typeof type !== "string") {
    return { valid: false, error: "position must have a 'type' field" };
  }

  if (type === "text") {
    const line = pos["line"];
    const side = pos["side"];
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      return { valid: false, error: "text position requires 'line' (positive integer)" };
    }
    if (side !== "base" && side !== "incoming") {
      return { valid: false, error: "text position requires 'side' ('base' or 'incoming')" };
    }
    return { valid: true, serialized: JSON.stringify(pos) };
  }

  if (type === "gltf") {
    const entityId = pos["entityId"];
    if (typeof entityId !== "string" || entityId.trim() === "") {
      return { valid: false, error: "gltf position requires non-empty 'entityId'" };
    }
    return { valid: true, serialized: JSON.stringify(pos) };
  }

  return { valid: false, error: `Unknown position type: '${type}'` };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function prCommentRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to submit a review (issue #87). Session/JWT
  // auth is unscoped and no-ops this guard; the route body keeps its own
  // author/access checks.
  const write = app.requireScope("repo:write");

  // ── Helper: resolve repo + PR by number ──────────────────────────────────────

  async function resolveRepoAndPR(
    handle: string,
    name: string,
    number: string,
    userId: string | undefined,
    reply: FastifyReply,
  ) {
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) {
      await reply.status(404).send({ error: "Not found" });
      return null;
    }
    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) {
      await reply.status(404).send({ error: "Pull request not found" });
      return null;
    }
    return { repo, pr };
  }

  /**
   * Mark the reviewer's active review request fulfilled (issue #82): a submitted
   * review satisfies an open "please review" pointing at its author. Dismissed or
   * already-fulfilled requests are untouched, so a later re-request can flip the
   * reviewer back to "requested". Best-effort — never fails the submission.
   */
  async function fulfillReviewerRequest(pullRequestId: string, reviewerId: string): Promise<void> {
    await prisma.pullRequestReviewerRequest.updateMany({
      where: { pullRequestId, userId: reviewerId, fulfilledAt: null, dismissedAt: null },
      data: { fulfilledAt: new Date() },
    });
  }

  /** Current head (`fromBranch`) SHA, for recording/computing review staleness. */
  async function headShaOf(
    repo: { storageKey: string | null },
    pr: { fromBranch: string },
  ): Promise<string | null> {
    if (!repo.storageKey) return null;
    try {
      return await resolveBranchSha(repo.storageKey, pr.fromBranch);
    } catch {
      return null;
    }
  }

  // ─── General PR Comments ──────────────────────────────────────────────────────

  // GET /repos/:handle/:name/pulls/:number/comments
  app.get(
    "/repos/:handle/:name/pulls/:number/comments",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const comments = await prisma.pullRequestComment.findMany({
        where: { pullRequestId: ctx.pr.id },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { handle: true } } },
      });

      // Reactions ride along, batched: ONE grouped query for the whole list (#90).
      const rollups = await reactionRollups("PR_COMMENT", comments.map((c) => c.id), userId);
      return { comments: comments.map((c) => formatPRComment(c, rollups.get(c.id))) };
    },
  );

  // POST /repos/:handle/:name/pulls/:number/comments
  app.post(
    "/repos/:handle/:name/pulls/:number/comments",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const { body } = request.body as { body?: string };

      // Strip leading `/command` lines out of the body (quick actions). On PRs,
      // only /close and /reopen map onto a mutation — the rest are reported back.
      const { commands, body: stripped } = parseQuickActions(body);
      if (commands.length === 0 && !stripped) return reply.status(400).send({ error: "body is required" });

      const comment = stripped
        ? await prisma.pullRequestComment.create({
            data: { pullRequestId: ctx.pr.id, authorId: userId, body: stripped },
            include: { author: { select: { handle: true } } },
          })
        : null;

      if (comment) {
        await syncBodyReferences({
          repo: ctx.repo, actorId: userId,
          source: { type: "PR_COMMENT", id: comment.id },
          container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
          body: comment.body,
        }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr comment)"));
      }

      const actions = await applyQuickActions({
        repo: ctx.repo, actorId: userId, commands,
        subject: {
          type: "PULL_REQUEST",
          pr: { id: ctx.pr.id, number: ctx.pr.number, authorId: ctx.pr.authorId, state: ctx.pr.state },
        },
        log: request.log,
      }).catch((err) => {
        request.log.error({ err }, "applyQuickActions (pr comment)");
        return { applied: [], rejected: [] };
      });

      const cf = comment ? formatPRComment(comment) : null;
      return reply.status(201).send({ ...(cf ?? {}), comment: cf, actions });
    },
  );

  // PATCH /repos/:handle/:name/pulls/:number/comments/:commentId
  app.patch(
    "/repos/:handle/:name/pulls/:number/comments/:commentId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const comment = await prisma.pullRequestComment.findFirst({
        where: { id: commentId, pullRequestId: ctx.pr.id },
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });

      if (comment.authorId !== userId) {
        return reply.status(403).send({ error: "Only the author can edit this comment" });
      }

      const { body } = request.body as { body?: string };
      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

      const updated = await prisma.pullRequestComment.update({
        where: { id: comment.id },
        data: { body: body.trim() },
        include: { author: { select: { handle: true } } },
      });

      await syncBodyReferences({
        repo: ctx.repo, actorId: userId,
        source: { type: "PR_COMMENT", id: comment.id },
        container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
        body: updated.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr comment edit)"));

      return formatPRComment(updated, await reactionRollupFor("PR_COMMENT", comment.id, userId));
    },
  );

  // DELETE /repos/:handle/:name/pulls/:number/comments/:commentId
  app.delete(
    "/repos/:handle/:name/pulls/:number/comments/:commentId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const comment = await prisma.pullRequestComment.findFirst({
        where: { id: commentId, pullRequestId: ctx.pr.id },
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });

      if (comment.authorId !== userId && ctx.repo.ownerId !== userId) {
        return reply.status(403).send({ error: "Only the author or repository owner can delete this comment" });
      }

      await prisma.pullRequestComment.delete({ where: { id: comment.id } });

      // Explicit reaction sweep — the polymorphic subject FK can't cascade (#90).
      await deleteSubjectReactions([{ subjectType: "PR_COMMENT", subjectIds: [comment.id] }]);

      return reply.status(204).send();
    },
  );

  // ─── PR Reviews ───────────────────────────────────────────────────────────────

  // GET /repos/:handle/:name/pulls/:number/reviews
  app.get(
    "/repos/:handle/:name/pulls/:number/reviews",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      // Submitted reviews are public; a PENDING review is a private draft visible
      // only to its own author (so "start a review" stays a draft until submitted).
      const reviews = await prisma.pullRequestReview.findMany({
        where: {
          pullRequestId: ctx.pr.id,
          OR: [
            { state: { not: "PENDING" } },
            ...(userId ? [{ authorId: userId, state: "PENDING" as const }] : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      const headSha = await headShaOf(ctx.repo, ctx.pr);
      return { reviews: reviews.map((r) => formatReview(r, { currentHeadSha: headSha })) };
    },
  );

  // POST /repos/:handle/:name/pulls/:number/reviews
  app.post(
    "/repos/:handle/:name/pulls/:number/reviews",
    { preHandler: [app.authenticate, write] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      // Authors cannot review their own PR
      if (ctx.pr.authorId === userId) {
        return reply.status(422).send({ error: "Authors cannot review their own pull request" });
      }

      const { state, body } = request.body as { state?: string; body?: string };

      const validStates = ["approved", "changes_requested", "commented"];
      let dbState: string;
      let submittedAt: Date | null = null;
      let commitSha: string | null = null;

      if (state) {
        if (!validStates.includes(state)) {
          return reply.status(400).send({ error: `state must be one of: ${validStates.join(", ")}` });
        }
        dbState = state.toUpperCase();
        submittedAt = new Date();
        commitSha = await headShaOf(ctx.repo, ctx.pr);
      } else {
        dbState = "PENDING";
      }

      const review = await prisma.pullRequestReview.create({
        data: {
          pullRequestId: ctx.pr.id,
          authorId: userId,
          state: dbState as "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
          body: body?.trim() || null,
          submittedAt,
          commitSha,
        },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      // Notify + record a spine event when a review is actually submitted.
      if (submittedAt) {
        await fulfillReviewerRequest(ctx.pr.id, userId)
          .catch((err) => request.log.error({ err }, "fulfillReviewerRequest (create review)"));
        void notifyUser(ctx.pr.authorId, { actorId: userId, repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectId: ctx.pr.id, subjectTitle: ctx.pr.title, reason: "COMMENT" });
        await recordEvent({
          repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectNumber: ctx.pr.number,
          kind: "reviewed", actorId: userId,
          data: { state: dbState.toLowerCase(), reviewId: review.id, commentCount: review._count?.comments ?? 0 },
        }).catch((err) => request.log.error({ err }, "recordEvent reviewed"));
        // Auto-merge signal (issue #119): a submitted review recomputes the
        // review gate — evaluate any armed intent now. Best-effort.
        void maybeAutoMergePr(ctx.pr.id, request.log).catch((err) => request.log.error({ err }, "auto-merge after review"));
      }

      return reply.status(201).send(formatReview(review, { currentHeadSha: commitSha }));
    },
  );

  // GET /repos/:handle/:name/pulls/:number/reviews/:reviewId
  app.get(
    "/repos/:handle/:name/pulls/:number/reviews/:reviewId",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number, reviewId } = request.params as {
        handle: string; name: string; number: string; reviewId: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const review = await prisma.pullRequestReview.findFirst({
        where: { id: reviewId, pullRequestId: ctx.pr.id },
        include: {
          author: { select: { handle: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { handle: true } },
              resolvedBy: { select: { handle: true } },
            },
          },
        },
      });

      if (!review) return reply.status(404).send({ error: "Review not found" });

      const headSha = await headShaOf(ctx.repo, ctx.pr);
      const rollups = await reactionRollups("PR_REVIEW_COMMENT", review.comments.map((c) => c.id), userId);
      return {
        ...formatReview(review, { commentCount: review.comments.length, currentHeadSha: headSha }),
        comments: review.comments.map((c) => formatReviewComment(c, rollups.get(c.id))),
      };
    },
  );

  // PUT /repos/:handle/:name/pulls/:number/reviews/:reviewId (submit)
  app.put(
    "/repos/:handle/:name/pulls/:number/reviews/:reviewId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, reviewId } = request.params as {
        handle: string; name: string; number: string; reviewId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const review = await prisma.pullRequestReview.findFirst({
        where: { id: reviewId, pullRequestId: ctx.pr.id },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });
      if (!review) return reply.status(404).send({ error: "Review not found" });

      if (review.authorId !== userId) {
        return reply.status(403).send({ error: "Only the review author can submit this review" });
      }

      if (review.state !== "PENDING") {
        return reply.status(422).send({ error: "Only PENDING reviews can be submitted" });
      }

      const { state, body } = request.body as { state?: string; body?: string };

      const validStates = ["approved", "changes_requested", "commented"];
      if (!state || !validStates.includes(state)) {
        return reply.status(400).send({ error: `state must be one of: ${validStates.join(", ")}` });
      }

      const commitSha = await headShaOf(ctx.repo, ctx.pr);
      const updated = await prisma.pullRequestReview.update({
        where: { id: review.id },
        data: {
          state: state.toUpperCase() as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
          body: body?.trim() || review.body,
          submittedAt: new Date(),
          commitSha,
        },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      await fulfillReviewerRequest(ctx.pr.id, userId)
        .catch((err) => request.log.error({ err }, "fulfillReviewerRequest (submit review)"));
      void notifyUser(ctx.pr.authorId, { actorId: userId, repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectId: ctx.pr.id, subjectTitle: ctx.pr.title, reason: "COMMENT" });
      await recordEvent({
        repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectNumber: ctx.pr.number,
        kind: "reviewed", actorId: userId,
        data: { state: state.toLowerCase(), reviewId: updated.id, commentCount: updated._count?.comments ?? 0 },
      }).catch((err) => request.log.error({ err }, "recordEvent reviewed"));
      // Auto-merge signal (issue #119): same hook as the direct-submit path.
      void maybeAutoMergePr(ctx.pr.id, request.log).catch((err) => request.log.error({ err }, "auto-merge after review"));

      return formatReview(updated, { currentHeadSha: commitSha });
    },
  );

  // DELETE /repos/:handle/:name/pulls/:number/reviews/:reviewId
  app.delete(
    "/repos/:handle/:name/pulls/:number/reviews/:reviewId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, reviewId } = request.params as {
        handle: string; name: string; number: string; reviewId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const review = await prisma.pullRequestReview.findFirst({
        where: { id: reviewId, pullRequestId: ctx.pr.id },
      });
      if (!review) return reply.status(404).send({ error: "Review not found" });

      if (review.authorId !== userId) {
        return reply.status(403).send({ error: "Only the review author can delete this review" });
      }

      if (review.state !== "PENDING") {
        return reply.status(422).send({ error: "Only PENDING reviews can be deleted" });
      }

      // The review's draft comments cascade with it; sweep their reactions (the
      // author may have reacted to their own drafts — no one else can see them).
      const commentIds = (
        await prisma.pullRequestReviewComment.findMany({ where: { reviewId: review.id }, select: { id: true } })
      ).map((c) => c.id);

      await prisma.pullRequestReview.delete({ where: { id: review.id } });

      await deleteSubjectReactions([{ subjectType: "PR_REVIEW_COMMENT", subjectIds: commentIds }]);

      return reply.status(204).send();
    },
  );

  // ─── Inline Review Comments ───────────────────────────────────────────────────

  // GET /repos/:handle/:name/pulls/:number/review-comments
  app.get(
    "/repos/:handle/:name/pulls/:number/review-comments",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      // Comments on submitted reviews are public; a reviewer's own PENDING draft
      // comments are visible only to them until they submit the review.
      const comments = await prisma.pullRequestReviewComment.findMany({
        where: {
          pullRequestId: ctx.pr.id,
          OR: [
            { review: { state: { not: "PENDING" } } },
            ...(userId ? [{ review: { authorId: userId, state: "PENDING" as const } }] : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { handle: true } },
          resolvedBy: { select: { handle: true } },
          review: { select: { state: true } },
        },
      });

      // Reactions ride along, batched: ONE grouped query for the whole list (#90).
      const rollups = await reactionRollups("PR_REVIEW_COMMENT", comments.map((c) => c.id), userId);
      return { comments: comments.map((c) => formatReviewComment(c, rollups.get(c.id))) };
    },
  );

  // POST /repos/:handle/:name/pulls/:number/review-comments
  app.post(
    "/repos/:handle/:name/pulls/:number/review-comments",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      // Cannot comment on your own PR
      if (ctx.pr.authorId === userId) {
        return reply.status(422).send({ error: "Authors cannot post review comments on their own pull request" });
      }

      const { body, filePath, position, suggestion } = request.body as {
        body?: string;
        filePath?: string;
        position?: unknown;
        suggestion?: unknown;
      };

      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });
      if (!filePath?.trim()) return reply.status(400).send({ error: "filePath is required" });

      const posResult = validatePosition(position);
      if (!posResult.valid) return reply.status(400).send({ error: posResult.error });

      const sugResult = validateSuggestion(suggestion, (position ?? {}) as { type?: unknown; side?: unknown });
      if (!sugResult.valid) return reply.status(400).send({ error: sugResult.error });

      // Find or create a PENDING review for this user on this PR
      let review = await prisma.pullRequestReview.findFirst({
        where: {
          pullRequestId: ctx.pr.id,
          authorId: userId,
          state: "PENDING",
        },
      });

      if (!review) {
        review = await prisma.pullRequestReview.create({
          data: {
            pullRequestId: ctx.pr.id,
            authorId: userId,
            state: "PENDING",
            body: null,
            submittedAt: null,
          },
        });
      }

      const comment = await prisma.pullRequestReviewComment.create({
        data: {
          reviewId: review.id,
          pullRequestId: ctx.pr.id,
          authorId: userId,
          body: body.trim(),
          filePath: filePath.trim(),
          position: posResult.serialized,
          suggestion: sugResult.value,
        },
        include: { author: { select: { handle: true } } },
      });

      await syncBodyReferences({
        repo: ctx.repo, actorId: userId,
        source: { type: "PR_REVIEW_COMMENT", id: comment.id },
        container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
        body: comment.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr review comment)"));

      return reply.status(201).send(formatReviewComment(comment));
    },
  );

  // PATCH /repos/:handle/:name/pulls/:number/review-comments/:commentId
  app.patch(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const comment = await prisma.pullRequestReviewComment.findFirst({
        where: { id: commentId, pullRequestId: ctx.pr.id },
        include: { author: { select: { handle: true } } },
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });

      if (comment.authorId !== userId) {
        return reply.status(403).send({ error: "Only the author can edit this comment" });
      }

      const { body } = request.body as { body?: string };
      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

      const updated = await prisma.pullRequestReviewComment.update({
        where: { id: comment.id },
        data: { body: body.trim() },
        include: { author: { select: { handle: true } } },
      });

      await syncBodyReferences({
        repo: ctx.repo, actorId: userId,
        source: { type: "PR_REVIEW_COMMENT", id: comment.id },
        container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
        body: updated.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr review comment edit)"));

      return formatReviewComment(updated, await reactionRollupFor("PR_REVIEW_COMMENT", comment.id, userId));
    },
  );

  // DELETE /repos/:handle/:name/pulls/:number/review-comments/:commentId
  app.delete(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const comment = await prisma.pullRequestReviewComment.findFirst({
        where: { id: commentId, pullRequestId: ctx.pr.id },
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });

      if (comment.authorId !== userId && ctx.repo.ownerId !== userId) {
        return reply.status(403).send({ error: "Only the author or repository owner can delete this comment" });
      }

      // Deleting a thread root cascades its replies (inReplyTo FK), so gather the
      // reply ids first and sweep their reactions along with the comment's own —
      // the polymorphic subject FK can't cascade (#90).
      const replyIds = (
        await prisma.pullRequestReviewComment.findMany({ where: { inReplyToId: comment.id }, select: { id: true } })
      ).map((r) => r.id);

      await prisma.pullRequestReviewComment.delete({ where: { id: comment.id } });

      await deleteSubjectReactions([{ subjectType: "PR_REVIEW_COMMENT", subjectIds: [comment.id, ...replyIds] }]);

      return reply.status(204).send();
    },
  );

  // ─── Threads: replies + resolution ────────────────────────────────────────────

  /** Resolve the thread root for a comment id: itself if a root, else its parent. */
  async function findThreadRoot(commentId: string, pullRequestId: string) {
    const comment = await prisma.pullRequestReviewComment.findFirst({
      where: { id: commentId, pullRequestId },
    });
    if (!comment) return null;
    if (!comment.inReplyToId) return comment;
    const root = await prisma.pullRequestReviewComment.findFirst({
      where: { id: comment.inReplyToId, pullRequestId },
    });
    // A stray reply whose root vanished falls back to itself.
    return root ?? comment;
  }

  // POST /repos/:handle/:name/pulls/:number/review-comments/:commentId/replies
  // Reply to a review thread. Attaches to the ROOT comment's review, so answering
  // a reviewer never opens a new pending review — and the PR author may reply too
  // (the "authors can't post review comments" rule is relaxed for replies).
  app.post(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId/replies",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;

      const { body, suggestion } = request.body as { body?: string; suggestion?: unknown };
      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

      const root = await findThreadRoot(commentId, ctx.pr.id);
      if (!root) return reply.status(404).send({ error: "Comment not found" });

      // A reply may carry its own suggestion (a counter-proposal); it anchors to
      // the ROOT's position, so it validates against that.
      const sugResult = validateSuggestion(suggestion, JSON.parse(root.position) as { type?: unknown; side?: unknown });
      if (!sugResult.valid) return reply.status(400).send({ error: sugResult.error });

      const created = await prisma.pullRequestReviewComment.create({
        data: {
          reviewId: root.reviewId,
          pullRequestId: ctx.pr.id,
          authorId: userId,
          body: body.trim(),
          filePath: root.filePath,
          position: root.position,
          inReplyToId: root.id,
          suggestion: sugResult.value,
        },
        include: {
          author: { select: { handle: true } },
          resolvedBy: { select: { handle: true } },
          review: { select: { state: true } },
        },
      });

      await syncBodyReferences({
        repo: ctx.repo, actorId: userId,
        source: { type: "PR_REVIEW_COMMENT", id: created.id },
        container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
        body: created.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr review reply)"));

      return reply.status(201).send(formatReviewComment(created));
    },
  );

  // POST /repos/:handle/:name/pulls/:number/review-comments/:commentId/resolve
  // Mark a thread resolved (resolution lives on the root comment).
  // DELETE the same path to unresolve. Allowed for a repo writer or the thread's
  // root author (so a reviewer can resolve threads they opened).
  async function setResolution(
    request: FastifyRequest,
    reply: FastifyReply,
    resolve: boolean,
  ) {
    const { handle, name, number, commentId } = request.params as {
      handle: string; name: string; number: string; commentId: string;
    };
    const userId = (request as { user: { sub: string } }).user.sub;

    const ctx = await resolveRepoAndPR(handle, name, number, userId, reply);
    if (!ctx) return;

    const root = await findThreadRoot(commentId, ctx.pr.id);
    if (!root) return reply.status(404).send({ error: "Comment not found" });

    if (!canWrite(ctx.repo, userId) && root.authorId !== userId) {
      return reply.status(403).send({ error: "Only a repository writer or the thread author can resolve this thread" });
    }

    const updated = await prisma.pullRequestReviewComment.update({
      where: { id: root.id },
      data: resolve
        ? { resolvedAt: new Date(), resolvedById: userId }
        : { resolvedAt: null, resolvedById: null },
      include: {
        author: { select: { handle: true } },
        resolvedBy: { select: { handle: true } },
        review: { select: { state: true } },
      },
    });

    return reply.send(formatReviewComment(updated, await reactionRollupFor("PR_REVIEW_COMMENT", updated.id, userId)));
  }

  app.post(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId/resolve",
    { preHandler: [app.authenticate] },
    async (request, reply) => setResolution(request, reply, true),
  );

  app.delete(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId/resolve",
    { preHandler: [app.authenticate] },
    async (request, reply) => setResolution(request, reply, false),
  );

  // ─── Suggested changes: apply (issue #119) ────────────────────────────────────

  // POST /repos/:handle/:name/pulls/:number/review-comments/:commentId/apply-suggestion
  //
  // Commit the comment's suggested replacement to the PR HEAD branch, authored
  // as the applying user. Writer-gated (it writes to the branch), guarded
  // against a concurrent head push by a compare-and-swap on the head SHA, and
  // followed by the same push fan-out an ordinary client push to the head
  // branch would fire — so CI, webhooks, review staleness, and the viewed-file
  // reset all see the new commit.
  app.post(
    "/repos/:handle/:name/pulls/:number/review-comments/:commentId/apply-suggestion",
    { preHandler: [app.authenticate, write] },
    async (request, reply) => {
      const { handle, name, number, commentId } = request.params as {
        handle: string; name: string; number: string; commentId: string;
      };
      const userId = request.user.sub;

      const ctx = await resolveRepoAndPR(handle, name, number, userId, reply as never);
      if (!ctx) return;
      if (!canWrite(ctx.repo, userId)) {
        return reply.status(403).send({ error: "Write access is required to apply a suggestion" });
      }
      if (!ctx.repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });
      if (ctx.pr.state !== "OPEN") {
        return reply.status(409).send({ error: `Pull request is ${ctx.pr.state.toLowerCase()}` });
      }

      const comment = await prisma.pullRequestReviewComment.findFirst({
        where: { id: commentId, pullRequestId: ctx.pr.id },
        include: { review: { select: { state: true } } },
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });
      // A PENDING review is a private draft: its suggestions do not exist for
      // anyone else yet, so they must not be applicable server-side either (the
      // web UI hides them, which is presentation, not a gate).
      if (comment.review?.state === "PENDING") {
        return reply.status(409).send({ error: "This suggestion is part of a pending review — submit the review first" });
      }
      if (comment.suggestion == null) return reply.status(400).send({ error: "This comment carries no suggestion" });
      if (comment.suggestionAppliedAt != null) {
        return reply.status(409).send({ error: "This suggestion was already applied" });
      }

      const position = JSON.parse(comment.position) as { type?: string; side?: string; line?: number };
      if (position.type !== "text" || position.side !== "incoming" || typeof position.line !== "number") {
        return reply.status(409).send({ error: "This suggestion is not anchored to an applyable line" });
      }

      const storageKey = ctx.repo.storageKey;

      // Branch protection (#85) on the HEAD branch. The commit below goes to the
      // bare repo with FORGEHUB_INTERNAL_PUSH=1, which bypasses the pre-receive
      // hook — so the rule the hook would have enforced has to be enforced here,
      // exactly as the merge endpoints enforce their own protection rules.
      // `requirePullRequest` is the flag that blocks direct pushes to a branch;
      // an apply IS a direct push, and (unlike a merge) nothing else sanctions it.
      const headRule = await prisma.protectedBranch.findFirst({
        where: { repoId: ctx.repo.id, branch: ctx.pr.fromBranch },
      });
      if (headRule?.requirePullRequest) {
        return reply.status(409).send({
          error: `Branch protection: "${ctx.pr.fromBranch}" is protected — direct pushes are blocked, so a suggestion cannot be applied to it.`,
          protection: true,
        });
      }

      const headSha = await resolveBranchSha(storageKey, ctx.pr.fromBranch);
      if (!headSha) return reply.status(409).send({ error: `Branch '${ctx.pr.fromBranch}' not found` });

      // Byte-exact read: the trimming `readFileAtBranch` inherits from `git()`
      // would strip the file's trailing newline / leading blank line AND shift
      // the anchored line number before the splice (issue #119).
      const content = await readFileAtBranchExact(storageKey, ctx.pr.fromBranch, comment.filePath);
      if (content === null) {
        return reply.status(409).send({ error: `'${comment.filePath}' no longer exists on '${ctx.pr.fromBranch}'` });
      }

      const applied = applySuggestionToContent(content, position.line, comment.suggestion);
      if (!applied.ok) return reply.status(409).send({ error: applied.error });

      const author = await resolveActorIdentity(userId);
      const message = `Apply suggestion to ${comment.filePath} (!${ctx.pr.number})`;
      let commit;
      try {
        commit = await commitFileToBranch(
          storageKey, ctx.pr.fromBranch, comment.filePath, applied.content, message, author, headSha,
        );
      } catch (err) {
        request.log.error({ err }, "commitFileToBranch threw unexpectedly");
        return reply.status(500).send({ error: "Applying the suggestion failed due to a server error" });
      }
      if (!commit.ok) {
        return reply.status(409).send({ error: "The head branch moved while applying — refresh and try again" });
      }

      const updated = await prisma.pullRequestReviewComment.update({
        where: { id: comment.id },
        data: { suggestionAppliedAt: new Date(), suggestionAppliedById: userId, suggestionCommitSha: commit.sha },
        include: {
          author: { select: { handle: true } },
          resolvedBy: { select: { handle: true } },
          review: { select: { state: true } },
        },
      });

      await recordEvent({
        repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectNumber: ctx.pr.number,
        kind: "suggestion_applied", actorId: userId,
        data: { filePath: comment.filePath, sha: commit.sha, commentId: comment.id },
      }).catch((err) => request.log.error({ err }, "recordEvent suggestion_applied"));

      // The head branch moved via an internal direct-to-bare push (bypasses
      // post-receive) — mirror a client push to `fromBranch`: push webhook +
      // push CI, head_pushed timeline event, pull_request CI re-run, viewed
      // reset, and artifact ingestion (issues #86/#87/#119).
      const changed = [{ branch: ctx.pr.fromBranch, oldSha: headSha ?? ZERO_SHA, newSha: commit.sha }];
      emitPushEvents(ctx.repo.id, storageKey, userId, changed);
      emitHeadPushedForPush(ctx.repo.id, userId, changed)
        .catch((err) => request.log.error({ err }, "head_pushed after suggestion apply"));
      void triggerWorkflowsForPrSync(ctx.repo.id, storageKey, changed)
        .catch((err) => request.log.error({ err }, "pull_request CI after suggestion apply"));
      void resetViewedFilesForPush(ctx.repo.id, storageKey, changed)
        .catch((err) => request.log.error({ err }, "viewed reset after suggestion apply"));
      {
        const repoPath = bareRepoPathFromKey(storageKey);
        const repoId = ctx.repo.id;
        const afterSha = commit.sha;
        setImmediate(() => {
          ingestCommitRange(repoId, repoPath, headSha, afterSha).catch(() => {});
        });
      }

      return { ...formatReviewComment(updated), sha: commit.sha };
    },
  );
}
