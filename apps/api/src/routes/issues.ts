import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

function formatIssue(issue: {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: { handle: string };
  assignee?: { handle: string } | null;
  labels: Array<{ label: { id: string; name: string; color: string } }>;
  _count?: { comments: number };
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toLowerCase(),
    author: issue.author.handle,
    assignee: issue.assignee?.handle ?? null,
    labels: issue.labels.map((il) => ({
      id: il.label.id,
      name: il.label.name,
      color: il.label.color,
    })),
    commentCount: issue._count?.comments ?? 0,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    closedAt: issue.closedAt?.toISOString() ?? null,
  };
}

function formatComment(comment: {
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

const issueInclude = {
  author: { select: { handle: true } },
  assignee: { select: { handle: true } },
  labels: { include: { label: { select: { id: true, name: true, color: true } } } },
  _count: { select: { comments: true } },
} as const;

export async function issueRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/issues
  app.get("/repos/:handle/:name/issues", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { state = "open", label, assignee } = request.query as {
      state?: string;
      label?: string;
      assignee?: string;
    };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const stateFilter =
      state === "closed" ? "CLOSED"
      : state === "all" ? undefined
      : "OPEN";

    const issues = await prisma.issue.findMany({
      where: {
        repoId: repo.id,
        ...(stateFilter ? { state: stateFilter } : {}),
        ...(label ? { labels: { some: { label: { name: label } } } } : {}),
        ...(assignee ? { assignee: { handle: assignee } } : {}),
      },
      orderBy: { number: "desc" },
      include: issueInclude,
    });

    return { issues: issues.map(formatIssue) };
  });

  // POST /repos/:handle/:name/issues
  app.post("/repos/:handle/:name/issues", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { title, body, assigneeId } = request.body as {
      title?: string;
      body?: string;
      assigneeId?: string;
    };

    if (!title?.trim()) return reply.status(400).send({ error: "title is required" });

    const issue = await prisma.$transaction(async (tx) => {
      const count = await tx.issue.count({ where: { repoId: repo.id } });
      return tx.issue.create({
        data: {
          repoId: repo.id,
          number: count + 1,
          title: title.trim(),
          body: body?.trim() || null,
          state: "OPEN",
          authorId: userId,
          assigneeId: assigneeId || null,
        },
        include: issueInclude,
      });
    });

    return reply.status(201).send(formatIssue(issue));
  });

  // GET /repos/:handle/:name/issues/:number
  app.get("/repos/:handle/:name/issues/:number", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({
      where: { repoId: repo.id, number: Number(number) },
      include: issueInclude,
    });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    return formatIssue(issue);
  });

  // PATCH /repos/:handle/:name/issues/:number
  app.patch("/repos/:handle/:name/issues/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    // Only author or writer can update
    if (issue.authorId !== userId && !canWrite(repo, userId)) {
      return reply.status(403).send({ error: "Only the author or a writer can modify this issue" });
    }

    const { title, body, state, assigneeId } = request.body as {
      title?: string;
      body?: string;
      state?: string;
      assigneeId?: string;
    };

    if (state !== undefined && !["open", "closed"].includes(state)) {
      return reply.status(400).send({ error: "state must be 'open' or 'closed'" });
    }

    const now = new Date();
    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(body !== undefined ? { body: body.trim() || null } : {}),
        ...(assigneeId !== undefined ? { assigneeId: assigneeId || null } : {}),
        ...(state === "closed" ? { state: "CLOSED", closedAt: now } : {}),
        ...(state === "open" ? { state: "OPEN", closedAt: null } : {}),
      },
      include: issueInclude,
    });

    return formatIssue(updated);
  });

  // DELETE /repos/:handle/:name/issues/:number
  app.delete("/repos/:handle/:name/issues/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    // Only author or repo owner can delete
    if (issue.authorId !== userId && repo.ownerId !== userId) {
      return reply.status(403).send({ error: "Only the author or repository owner can delete this issue" });
    }

    await prisma.issue.delete({ where: { id: issue.id } });

    return reply.status(204).send();
  });

  // ─── Comments ─────────────────────────────────────────────────────────────────

  // GET /repos/:handle/:name/issues/:number/comments
  app.get("/repos/:handle/:name/issues/:number/comments", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const comments = await prisma.issueComment.findMany({
      where: { issueId: issue.id },
      orderBy: { createdAt: "asc" },
      include: { author: { select: { handle: true } } },
    });

    return { comments: comments.map(formatComment) };
  });

  // POST /repos/:handle/:name/issues/:number/comments
  app.post("/repos/:handle/:name/issues/:number/comments", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const { body } = request.body as { body?: string };
    if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

    const comment = await prisma.issueComment.create({
      data: {
        issueId: issue.id,
        authorId: userId,
        body: body.trim(),
      },
      include: { author: { select: { handle: true } } },
    });

    return reply.status(201).send(formatComment(comment));
  });

  // PATCH /repos/:handle/:name/issues/:number/comments/:commentId
  app.patch("/repos/:handle/:name/issues/:number/comments/:commentId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number, commentId } = request.params as {
      handle: string; name: string; number: string; commentId: string;
    };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const comment = await prisma.issueComment.findFirst({ where: { id: commentId, issueId: issue.id } });
    if (!comment) return reply.status(404).send({ error: "Comment not found" });

    // Only author can edit
    if (comment.authorId !== userId) {
      return reply.status(403).send({ error: "Only the author can edit this comment" });
    }

    const { body } = request.body as { body?: string };
    if (!body?.trim()) return reply.status(400).send({ error: "body is required" });

    const updated = await prisma.issueComment.update({
      where: { id: comment.id },
      data: { body: body.trim() },
      include: { author: { select: { handle: true } } },
    });

    return formatComment(updated);
  });

  // DELETE /repos/:handle/:name/issues/:number/comments/:commentId
  app.delete("/repos/:handle/:name/issues/:number/comments/:commentId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number, commentId } = request.params as {
      handle: string; name: string; number: string; commentId: string;
    };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const comment = await prisma.issueComment.findFirst({ where: { id: commentId, issueId: issue.id } });
    if (!comment) return reply.status(404).send({ error: "Comment not found" });

    // Author or repo owner can delete
    if (comment.authorId !== userId && repo.ownerId !== userId) {
      return reply.status(403).send({ error: "Only the author or repository owner can delete this comment" });
    }

    await prisma.issueComment.delete({ where: { id: comment.id } });

    return reply.status(204).send();
  });

  // ─── Issue Labels ─────────────────────────────────────────────────────────────

  // POST /repos/:handle/:name/issues/:number/labels
  app.post("/repos/:handle/:name/issues/:number/labels", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const { labelId } = request.body as { labelId?: string };
    if (!labelId) return reply.status(400).send({ error: "labelId is required" });

    const label = await prisma.label.findFirst({ where: { id: labelId, repoId: repo.id } });
    if (!label) return reply.status(404).send({ error: "Label not found" });

    await prisma.issueLabel.create({
      data: { issueId: issue.id, labelId: label.id },
    });

    return reply.status(201).send({ issueId: issue.id, labelId: label.id });
  });

  // DELETE /repos/:handle/:name/issues/:number/labels/:labelId
  app.delete("/repos/:handle/:name/issues/:number/labels/:labelId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number, labelId } = request.params as {
      handle: string; name: string; number: string; labelId: string;
    };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const issueLabel = await prisma.issueLabel.findFirst({
      where: { issueId: issue.id, labelId },
    });
    if (!issueLabel) return reply.status(404).send({ error: "Label not applied to this issue" });

    await prisma.issueLabel.delete({
      where: { issueId_labelId: { issueId: issue.id, labelId } },
    });

    return reply.status(204).send();
  });
}
