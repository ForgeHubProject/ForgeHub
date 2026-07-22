import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { notifySubscribers, notifyUser } from "../notifications-service.js";
import { recordEvent } from "../timeline-service.js";
import { syncBodyReferences } from "../references-service.js";

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
  // Issue-triage (#120) — optional so mocked/legacy rows without them still format.
  pinnedAt?: Date | null;
  locked?: boolean | null;
  lockReason?: string | null;
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
    pinnedAt: issue.pinnedAt ? issue.pinnedAt.toISOString() : null,
    locked: issue.locked ?? false,
    lockReason: issue.lockReason ?? null,
  };
}

/** Max pinned issues per repo (GitHub's cap). */
const PIN_CAP = 3;

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
    const { state = "open", label, assignee, author, sort } = request.query as {
      state?: string;
      label?: string;
      assignee?: string;
      author?: string;
      sort?: string;
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
        ...(author ? { author: { handle: author } } : {}),
      },
      // Pinned first (SQLite sorts NULLs last under DESC, so pinned rows lead),
      // then the requested number order. The list UI lifts pinned rows into their
      // own card row; this just guarantees they're present and ahead.
      orderBy: [{ pinnedAt: "desc" }, sort === "oldest" ? { number: "asc" } : { number: "desc" }],
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

    // Fan out notifications (fire-and-forget — don't block the response)
    void notifySubscribers({ actorId: userId, repoId: repo.id, subjectType: "ISSUE", subjectId: issue.id, subjectTitle: issue.title, reason: "SUBSCRIBED" });
    if (issue.assigneeId) {
      void notifyUser(issue.assigneeId, { actorId: userId, repoId: repo.id, subjectType: "ISSUE", subjectId: issue.id, subjectTitle: issue.title, reason: "ASSIGNED" });
    }

    // Parse #N / !N / @handle out of the body into cross-refs, link-backs, mentions.
    await syncBodyReferences({
      repo, actorId: userId,
      source: { type: "ISSUE", id: issue.id },
      container: { subjectType: "ISSUE", id: issue.id, number: issue.number, title: issue.title },
      body: issue.body,
    }).catch((err) => request.log.error({ err }, "syncBodyReferences (issue create)"));

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
    if (!issue) {
      // Transfer tombstone: if this number was transferred *out*, point the caller
      // at the new location instead of a bare 404 (issue #120 / cross-refs #79).
      const tomb = await prisma.timelineEvent.findFirst({
        where: { repoId: repo.id, subjectType: "ISSUE", subjectNumber: Number(number), kind: "transferred" },
        orderBy: { createdAt: "desc" },
      });
      if (tomb) {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(tomb.data) as Record<string, unknown>; } catch { /* ignore */ }
        if (data["direction"] === "out" && typeof data["repo"] === "string" && typeof data["number"] === "number") {
          return reply.status(410).send({
            error: `This issue was transferred to ${data["repo"]}#${data["number"]}`,
            transferredTo: { repo: data["repo"], number: data["number"], url: `/${data["repo"]}/issues/${data["number"]}` },
          });
        }
      }
      return reply.status(404).send({ error: "Issue not found" });
    }

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

    // ── Timeline events for the state changes this PATCH performed ────────────────
    const emit = (kind: Parameters<typeof recordEvent>[0]["kind"], data?: Record<string, unknown>) =>
      recordEvent({ repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number, kind, actorId: userId, data })
        .catch((err) => request.log.error({ err }, `recordEvent ${kind} (issue)`));

    if (title !== undefined && updated.title !== issue.title) {
      await emit("title_changed", { from: issue.title, to: updated.title });
    }
    if (state === "closed" && issue.state !== "CLOSED") await emit("closed");
    if (state === "open" && issue.state !== "OPEN") await emit("reopened");
    if (assigneeId !== undefined && updated.assigneeId !== issue.assigneeId) {
      if (updated.assigneeId) {
        await emit("assigned", { assignee: updated.assignee?.handle });
      } else {
        const prev = await prisma.user.findUnique({ where: { id: issue.assigneeId! }, select: { handle: true } });
        await emit("unassigned", { assignee: prev?.handle });
      }
    }
    if (body !== undefined && updated.body !== issue.body) {
      await syncBodyReferences({
        repo, actorId: userId,
        source: { type: "ISSUE", id: issue.id },
        container: { subjectType: "ISSUE", id: issue.id, number: issue.number, title: updated.title },
        body: updated.body,
      }).catch((err) => request.log.error({ err }, "syncBodyReferences (issue edit)"));
    }

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

    // Locked conversation (#120): only writers may add comments once locked.
    if (issue.locked && !canWrite(repo, userId)) {
      return reply.status(403).send({ error: "This conversation is locked. Only collaborators with write access can comment." });
    }

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

    // Notify issue participants (author + assignee, not self)
    const participants = new Set([issue.authorId, issue.assigneeId].filter(Boolean) as string[]);
    for (const uid of participants) {
      void notifyUser(uid, { actorId: userId, repoId: repo.id, subjectType: "ISSUE", subjectId: issue.id, subjectTitle: issue.title, reason: "COMMENT" });
    }

    await syncBodyReferences({
      repo, actorId: userId,
      source: { type: "ISSUE_COMMENT", id: comment.id },
      container: { subjectType: "ISSUE", id: issue.id, number: issue.number, title: issue.title },
      body: comment.body,
    }).catch((err) => request.log.error({ err }, "syncBodyReferences (issue comment)"));

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

    await syncBodyReferences({
      repo, actorId: userId,
      source: { type: "ISSUE_COMMENT", id: comment.id },
      container: { subjectType: "ISSUE", id: issue.id, number: issue.number, title: issue.title },
      body: updated.body,
    }).catch((err) => request.log.error({ err }, "syncBodyReferences (issue comment edit)"));

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

    await recordEvent({
      repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number,
      kind: "labeled", actorId: userId,
      data: { label: { name: label.name, color: label.color } },
    }).catch((err) => request.log.error({ err }, "recordEvent labeled"));

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

    const label = await prisma.label.findFirst({ where: { id: labelId, repoId: repo.id } });

    await prisma.issueLabel.delete({
      where: { issueId_labelId: { issueId: issue.id, labelId } },
    });

    await recordEvent({
      repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number,
      kind: "unlabeled", actorId: userId,
      data: { label: label ? { name: label.name, color: label.color } : undefined },
    }).catch((err) => request.log.error({ err }, "recordEvent unlabeled"));

    return reply.status(204).send();
  });

  // ─── Pinned issues (#120) ─────────────────────────────────────────────────────

  // POST /repos/:handle/:name/issues/:number/pin — writer-gated, cap PIN_CAP/repo.
  app.post("/repos/:handle/:name/issues/:number/pin", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) }, include: issueInclude });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    if (!issue.pinnedAt) {
      const pinnedCount = await prisma.issue.count({ where: { repoId: repo.id, pinnedAt: { not: null } } });
      if (pinnedCount >= PIN_CAP) {
        return reply.status(409).send({ error: `At most ${PIN_CAP} issues can be pinned per repository. Unpin one first.` });
      }
    }

    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: { pinnedAt: issue.pinnedAt ?? new Date() },
      include: issueInclude,
    });

    if (!issue.pinnedAt) {
      await recordEvent({ repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number, kind: "pinned", actorId: userId })
        .catch((err) => request.log.error({ err }, "recordEvent pinned"));
    }

    return formatIssue(updated);
  });

  // DELETE /repos/:handle/:name/issues/:number/pin — writer-gated unpin.
  app.delete("/repos/:handle/:name/issues/:number/pin", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) }, include: issueInclude });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: { pinnedAt: null },
      include: issueInclude,
    });

    if (issue.pinnedAt) {
      await recordEvent({ repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number, kind: "unpinned", actorId: userId })
        .catch((err) => request.log.error({ err }, "recordEvent unpinned"));
    }

    return formatIssue(updated);
  });

  // ─── Locked conversations (#120) ──────────────────────────────────────────────

  // POST /repos/:handle/:name/issues/:number/lock — writer-gated; optional { reason }.
  app.post("/repos/:handle/:name/issues/:number/lock", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) }, include: issueInclude });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const { reason } = request.body as { reason?: string };
    const wasLocked = issue.locked;

    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: { locked: true, lockedAt: new Date(), lockedById: userId, lockReason: reason?.trim() || null },
      include: issueInclude,
    });

    if (!wasLocked) {
      await recordEvent({
        repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number,
        kind: "locked", actorId: userId, data: reason?.trim() ? { reason: reason.trim() } : undefined,
      }).catch((err) => request.log.error({ err }, "recordEvent locked"));
    }

    return formatIssue(updated);
  });

  // DELETE /repos/:handle/:name/issues/:number/lock — writer-gated unlock.
  app.delete("/repos/:handle/:name/issues/:number/lock", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) }, include: issueInclude });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const wasLocked = issue.locked;
    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: { locked: false, lockedAt: null, lockedById: null, lockReason: null },
      include: issueInclude,
    });

    if (wasLocked) {
      await recordEvent({ repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number, kind: "unlocked", actorId: userId })
        .catch((err) => request.log.error({ err }, "recordEvent unlocked"));
    }

    return formatIssue(updated);
  });

  // ─── Issue transfer (#120) ────────────────────────────────────────────────────

  // POST /repos/:handle/:name/issues/:number/transfer  body { targetRepo }
  // v0 constraint: the target repo must be owned by the SAME owner. Re-numbers in
  // the target's sequence, remaps labels by name, and leaves a timeline event on
  // both sides. The old URL then resolves to a 410 pointer (see GET above).
  app.post("/repos/:handle/:name/issues/:number/transfer", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({
      where: { repoId: repo.id, number: Number(number) },
      include: { labels: { include: { label: { select: { name: true } } } } },
    });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    // Author or a writer may transfer.
    if (issue.authorId !== userId && !canWrite(repo, userId)) {
      return reply.status(403).send({ error: "Only the author or a writer can transfer this issue" });
    }

    const { targetRepo } = request.body as { targetRepo?: string };
    if (!targetRepo?.trim()) return reply.status(400).send({ error: "targetRepo is required" });

    // Accept "name" (same owner) or "owner/name".
    const trimmed = targetRepo.trim();
    const [tHandle, tName] = trimmed.includes("/") ? trimmed.split("/", 2) : [handle, trimmed];
    const target = await resolveRepo(tHandle!, tName!);
    if (!target) return reply.status(404).send({ error: "Target repository not found" });
    if (target.id === repo.id) return reply.status(400).send({ error: "Issue is already in this repository" });

    // v0 constraint — same owner only. (Cross-owner / cross-org transfer is a follow-up.)
    if (target.ownerId !== repo.ownerId) {
      return reply.status(400).send({ error: "v0: an issue can only be transferred to another repository owned by the same owner." });
    }
    if (!canWrite(target, userId)) return reply.status(403).send({ error: "Write access to the target repository is required" });

    // Fresh number = max(number)+1 in the target (robust against gaps from prior transfers).
    const top = await prisma.issue.findFirst({
      where: { repoId: target.id }, orderBy: { number: "desc" }, select: { number: true },
    });
    const newNumber = (top?.number ?? 0) + 1;

    // Remap labels to the target repo by name; unmatched labels are dropped.
    const targetLabels = await prisma.label.findMany({ where: { repoId: target.id }, select: { id: true, name: true } });
    const byName = new Map(targetLabels.map((l) => [l.name, l.id]));
    const remapLabelIds = issue.labels
      .map((il) => byName.get(il.label.name))
      .filter((id): id is string => Boolean(id));

    await prisma.$transaction(async (tx) => {
      await tx.issueLabel.deleteMany({ where: { issueId: issue.id } });
      for (const labelId of remapLabelIds) {
        await tx.issueLabel.create({ data: { issueId: issue.id, labelId } });
      }
      await tx.issue.update({
        // Comments follow the row automatically (FK on issueId); pin is per-repo, so drop it.
        where: { id: issue.id },
        data: { repoId: target.id, number: newNumber, pinnedAt: null },
      });
    });

    // v0 keeps both repos under the same owner, so the source URL handle names both.
    const sourceFull = `${handle}/${repo.name}`;
    const targetFull = `${handle}/${target.name}`;

    // A timeline event on both sides: an "out" tombstone on the source (old number)
    // and an "in" marker on the target (new number).
    await recordEvent({
      repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number,
      kind: "transferred", actorId: userId, data: { direction: "out", repo: targetFull, number: newNumber },
    }).catch((err) => request.log.error({ err }, "recordEvent transferred(out)"));
    await recordEvent({
      repoId: target.id, subjectType: "ISSUE", subjectNumber: newNumber,
      kind: "transferred", actorId: userId, data: { direction: "in", repo: sourceFull, number: issue.number },
    }).catch((err) => request.log.error({ err }, "recordEvent transferred(in)"));

    return reply.send({
      id: issue.id,
      number: newNumber,
      repo: targetFull,
      handle,
      name: target.name,
      url: `/${targetFull}/issues/${newNumber}`,
    });
  });

  // ─── Saved filter views (#120) — per-user, per-repo ───────────────────────────

  const formatSavedFilter = (f: { id: string; name: string; query: string; scope: string; createdAt: Date }) => ({
    id: f.id, name: f.name, query: f.query, scope: f.scope.toLowerCase(), createdAt: f.createdAt.toISOString(),
  });

  // GET /repos/:handle/:name/saved-filters — the caller's own saved views for this repo.
  app.get("/repos/:handle/:name/saved-filters", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const filters = await prisma.savedFilter.findMany({
      where: { repoId: repo.id, ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
    return { savedFilters: filters.map(formatSavedFilter) };
  });

  // POST /repos/:handle/:name/saved-filters  body { name, query, scope? }
  app.post("/repos/:handle/:name/saved-filters", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { name: filterName, query, scope } = request.body as { name?: string; query?: string; scope?: string };
    if (!filterName?.trim()) return reply.status(400).send({ error: "name is required" });
    const scopeValue = scope?.toUpperCase() === "PULL_REQUEST" ? "PULL_REQUEST" : "ISSUE";

    const existing = await prisma.savedFilter.findFirst({
      where: { repoId: repo.id, ownerId: userId, scope: scopeValue, name: filterName.trim() },
    });
    if (existing) return reply.status(409).send({ error: "A saved view with this name already exists" });

    const created = await prisma.savedFilter.create({
      data: { repoId: repo.id, ownerId: userId, name: filterName.trim(), query: (query ?? "").trim(), scope: scopeValue },
    });
    return reply.status(201).send(formatSavedFilter(created));
  });

  // DELETE /repos/:handle/:name/saved-filters/:id — owner of the view only.
  app.delete("/repos/:handle/:name/saved-filters/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const filter = await prisma.savedFilter.findFirst({ where: { id, repoId: repo.id } });
    if (!filter) return reply.status(404).send({ error: "Saved view not found" });
    if (filter.ownerId !== userId) return reply.status(403).send({ error: "You can only delete your own saved views" });

    await prisma.savedFilter.delete({ where: { id: filter.id } });
    return reply.status(204).send();
  });
}
