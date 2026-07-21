import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { notifyUser } from "../notifications-service.js";
import { syncBodyReferences } from "../references-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPRComment(comment: {
  id: string;
  body: string;
  author: { handle: string };
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.author.handle,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

function formatReview(
  review: {
    id: string;
    state: string;
    body: string | null;
    author: { handle: string };
    submittedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    _count?: { comments: number };
  },
  commentCount?: number,
) {
  return {
    id: review.id,
    state: review.state.toLowerCase(),
    body: review.body,
    author: review.author.handle,
    submittedAt: review.submittedAt?.toISOString() ?? null,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    commentCount: commentCount ?? review._count?.comments ?? 0,
  };
}

function formatReviewComment(comment: {
  id: string;
  reviewId: string;
  body: string;
  author: { handle: string };
  filePath: string;
  position: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: comment.id,
    reviewId: comment.reviewId,
    body: comment.body,
    author: comment.author.handle,
    filePath: comment.filePath,
    position: JSON.parse(comment.position) as unknown,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
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

      return { comments: comments.map(formatPRComment) };
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
      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

      const comment = await prisma.pullRequestComment.create({
        data: {
          pullRequestId: ctx.pr.id,
          authorId: userId,
          body: body.trim(),
        },
        include: { author: { select: { handle: true } } },
      });

      await syncBodyReferences({
        repo: ctx.repo, actorId: userId,
        source: { type: "PR_COMMENT", id: comment.id },
        container: { subjectType: "PULL_REQUEST", id: ctx.pr.id, number: ctx.pr.number, title: ctx.pr.title },
        body: comment.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (pr comment)"));

      return reply.status(201).send(formatPRComment(comment));
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

      return formatPRComment(updated);
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

      const reviews = await prisma.pullRequestReview.findMany({
        where: { pullRequestId: ctx.pr.id },
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      return { reviews: reviews.map((r) => formatReview(r)) };
    },
  );

  // POST /repos/:handle/:name/pulls/:number/reviews
  app.post(
    "/repos/:handle/:name/pulls/:number/reviews",
    { preHandler: [app.authenticate] },
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

      if (state) {
        if (!validStates.includes(state)) {
          return reply.status(400).send({ error: `state must be one of: ${validStates.join(", ")}` });
        }
        dbState = state.toUpperCase();
        submittedAt = new Date();
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
        },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      // Notify PR author when a review is actually submitted (not left as PENDING)
      if (submittedAt) {
        void notifyUser(ctx.pr.authorId, { actorId: userId, repoId: ctx.repo.id, subjectType: "PULL_REQUEST", subjectId: ctx.pr.id, subjectTitle: ctx.pr.title, reason: "COMMENT" });
      }

      return reply.status(201).send(formatReview(review));
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
            include: { author: { select: { handle: true } } },
          },
        },
      });

      if (!review) return reply.status(404).send({ error: "Review not found" });

      return {
        ...formatReview(review, review.comments.length),
        comments: review.comments.map(formatReviewComment),
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

      const updated = await prisma.pullRequestReview.update({
        where: { id: review.id },
        data: {
          state: state.toUpperCase() as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
          body: body?.trim() || review.body,
          submittedAt: new Date(),
        },
        include: {
          author: { select: { handle: true } },
          _count: { select: { comments: true } },
        },
      });

      return formatReview(updated);
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

      await prisma.pullRequestReview.delete({ where: { id: review.id } });

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

      const comments = await prisma.pullRequestReviewComment.findMany({
        where: { pullRequestId: ctx.pr.id },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { handle: true } } },
      });

      return { comments: comments.map(formatReviewComment) };
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

      const { body, filePath, position } = request.body as {
        body?: string;
        filePath?: string;
        position?: unknown;
      };

      if (!body?.trim()) return reply.status(400).send({ error: "body is required" });
      if (!filePath?.trim()) return reply.status(400).send({ error: "filePath is required" });

      const posResult = validatePosition(position);
      if (!posResult.valid) return reply.status(400).send({ error: posResult.error });

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

      return formatReviewComment(updated);
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

      await prisma.pullRequestReviewComment.delete({ where: { id: comment.id } });

      return reply.status(204).send();
    },
  );
}
