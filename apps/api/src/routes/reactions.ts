import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import {
  isReactionEmoji,
  reactionRollupFor,
  REACTION_EMOJIS,
  type ReactionSubjectType,
} from "../reactions-service.js";

// Wire subjectType values (lowercase, matching the API's serialized enum
// convention — cf. SavedFilter.scope) → DB enum values.
const SUBJECT_TYPES: Record<string, ReactionSubjectType> = {
  issue: "ISSUE",
  pull_request: "PULL_REQUEST",
  issue_comment: "ISSUE_COMMENT",
  pr_comment: "PR_COMMENT",
  pr_review_comment: "PR_REVIEW_COMMENT",
};

/**
 * Does the subject exist, and does it belong to THIS repo? Being subject-generic
 * keeps the endpoint to one route family, but means the handler must pin the
 * subject to the repo in the URL — otherwise a caller could react to (and thereby
 * probe the existence of) subjects in repos they cannot read. A PENDING review's
 * inline comments are a private draft, so only their author may react to them
 * (everyone else sees the same 404 as for a missing subject).
 */
async function subjectInRepo(
  subjectType: ReactionSubjectType,
  subjectId: string,
  repoId: string,
  viewerId: string,
): Promise<boolean> {
  switch (subjectType) {
    case "ISSUE":
      return !!(await prisma.issue.findFirst({ where: { id: subjectId, repoId }, select: { id: true } }));
    case "PULL_REQUEST":
      return !!(await prisma.pullRequest.findFirst({ where: { id: subjectId, repoId }, select: { id: true } }));
    case "ISSUE_COMMENT":
      return !!(await prisma.issueComment.findFirst({ where: { id: subjectId, issue: { repoId } }, select: { id: true } }));
    case "PR_COMMENT":
      return !!(await prisma.pullRequestComment.findFirst({ where: { id: subjectId, pullRequest: { repoId } }, select: { id: true } }));
    case "PR_REVIEW_COMMENT":
      return !!(await prisma.pullRequestReviewComment.findFirst({
        where: {
          id: subjectId,
          pullRequest: { repoId },
          OR: [{ review: { state: { not: "PENDING" } } }, { review: { authorId: viewerId } }],
        },
        select: { id: true },
      }));
  }
}

export async function reactionRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to toggle a reaction (issue #87) — it's a
  // mutation, however small. Session/JWT auth is unscoped and no-ops this guard.
  const write = app.requireScope("repo:write");

  /**
   * Shared parse + access check for both verbs. Returns the resolved context or
   * null after having sent the error response.
   */
  async function resolveToggle(request: { params: unknown; body: unknown; user: { sub: string } }, reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
  }) {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) {
      reply.status(404).send({ error: "Not found" });
      return null;
    }

    const { subjectType, subjectId, emoji } = (request.body ?? {}) as {
      subjectType?: string; subjectId?: string; emoji?: string;
    };

    const dbType = subjectType ? SUBJECT_TYPES[subjectType] : undefined;
    if (!dbType) {
      reply.status(400).send({ error: `subjectType must be one of: ${Object.keys(SUBJECT_TYPES).join(", ")}` });
      return null;
    }
    if (!subjectId?.trim()) {
      reply.status(400).send({ error: "subjectId is required" });
      return null;
    }
    if (!isReactionEmoji(emoji)) {
      reply.status(400).send({ error: `emoji must be one of: ${REACTION_EMOJIS.join(", ")}` });
      return null;
    }

    if (!(await subjectInRepo(dbType, subjectId, repo.id, userId))) {
      reply.status(404).send({ error: "Subject not found" });
      return null;
    }

    return { userId, subjectType: subjectType as string, dbType, subjectId, emoji };
  }

  // PUT /repos/:handle/:name/reactions  body { subjectType, subjectId, emoji }
  // Idempotent add: reacting twice with the same emoji is one row (upsert on the
  // unique constraint), and both calls return the same fresh rollup.
  app.put("/repos/:handle/:name/reactions", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const ctx = await resolveToggle(request as never, reply as never);
    if (!ctx) return;

    await prisma.reaction.upsert({
      where: {
        subjectType_subjectId_userId_emoji: {
          subjectType: ctx.dbType, subjectId: ctx.subjectId, userId: ctx.userId, emoji: ctx.emoji,
        },
      },
      create: { subjectType: ctx.dbType, subjectId: ctx.subjectId, userId: ctx.userId, emoji: ctx.emoji },
      update: {},
    });

    const rollup = await reactionRollupFor(ctx.dbType, ctx.subjectId, ctx.userId);
    return { subjectType: ctx.subjectType, subjectId: ctx.subjectId, ...rollup };
  });

  // DELETE /repos/:handle/:name/reactions  body { subjectType, subjectId, emoji }
  // Removes the caller's OWN reaction only (userId is pinned to the caller).
  // deleteMany keeps it idempotent — removing a reaction you never added is a
  // no-op that still returns the current rollup.
  app.delete("/repos/:handle/:name/reactions", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const ctx = await resolveToggle(request as never, reply as never);
    if (!ctx) return;

    await prisma.reaction.deleteMany({
      where: { subjectType: ctx.dbType, subjectId: ctx.subjectId, userId: ctx.userId, emoji: ctx.emoji },
    });

    const rollup = await reactionRollupFor(ctx.dbType, ctx.subjectId, ctx.userId);
    return { subjectType: ctx.subjectType, subjectId: ctx.subjectId, ...rollup };
  });
}
