import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude } from "../repo-access.js";

/** At most this many rows per list, newest activity first. */
const LIMIT = 100;

const repoSelect = { include: { ...repoAccessInclude, owner: { select: { handle: true } } } } as const;
const labelsSelect = { include: { label: { select: { id: true, name: true, color: true } } } } as const;

type RepoRow = Prisma.RepoGetPayload<typeof repoSelect>;
const repoRef = (r: RepoRow) => ({ owner: r.org?.handle ?? r.owner.handle, name: r.name });

/**
 * "Your issues" and "your pull requests" across every repository (#255),
 * GitHub's /issues and /pulls: assigned, created, mentioned, review requests.
 * Rows from repositories the caller can no longer read are dropped.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  // GET /user/issues?filter=assigned|created|mentioned&state=open|closed|all
  app.get("/user/issues", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const { filter = "assigned", state = "open" } = request.query as { filter?: string; state?: string };
    if (!["assigned", "created", "mentioned"].includes(filter)) return reply.status(400).send({ error: "Unknown filter" });

    let who: Prisma.IssueWhereInput;
    if (filter === "assigned") who = { assigneeId: userId };
    else if (filter === "created") who = { authorId: userId };
    else {
      const mentions = await prisma.notification.findMany({
        where: { userId, reason: "MENTIONED", subjectType: "ISSUE" },
        select: { subjectId: true },
        take: 500,
      });
      who = { id: { in: mentions.map((m) => m.subjectId) } };
    }
    const issues = await prisma.issue.findMany({
      where: { ...who, ...(state === "all" ? {} : { state: state === "closed" ? "CLOSED" : "OPEN" }) },
      orderBy: { updatedAt: "desc" },
      take: LIMIT * 2,
      include: {
        repo: repoSelect,
        author: { select: { handle: true } },
        assignee: { select: { handle: true } },
        labels: labelsSelect,
        _count: { select: { comments: true } },
      },
    });
    return {
      issues: issues
        .filter((i) => canRead(i.repo, userId))
        .slice(0, LIMIT)
        .map((i) => ({
          repo: repoRef(i.repo),
          number: i.number,
          title: i.title,
          state: i.state.toLowerCase(),
          author: i.author.handle,
          assignee: i.assignee?.handle ?? null,
          labels: i.labels.map((l) => l.label),
          comments: i._count.comments,
          createdAt: i.createdAt.toISOString(),
          updatedAt: i.updatedAt.toISOString(),
        })),
    };
  });

  // GET /user/pulls?filter=created|assigned|review_requested|involved&state=open|closed|merged|all
  app.get("/user/pulls", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const { filter = "created", state = "open" } = request.query as { filter?: string; state?: string };
    if (!["created", "assigned", "review_requested", "involved"].includes(filter)) {
      return reply.status(400).send({ error: "Unknown filter" });
    }

    // Outstanding review requests: asked, not yet reviewed, not withdrawn.
    const requestedIds = async () =>
      (await prisma.pullRequestReviewerRequest.findMany({
        where: { userId, fulfilledAt: null, dismissedAt: null },
        select: { pullRequestId: true },
        take: 500,
      })).map((r) => r.pullRequestId);

    let who: Prisma.PullRequestWhereInput;
    if (filter === "created") who = { authorId: userId };
    else if (filter === "assigned") who = { assigneeId: userId };
    else if (filter === "review_requested") who = { id: { in: await requestedIds() } };
    else {
      who = {
        OR: [
          { authorId: userId },
          { assigneeId: userId },
          { id: { in: await requestedIds() } },
          { comments: { some: { authorId: userId } } },
          { reviews: { some: { authorId: userId } } },
        ],
      };
    }
    const stateWhere: Prisma.PullRequestWhereInput =
      state === "all" ? {} : { state: state === "closed" ? "CLOSED" : state === "merged" ? "MERGED" : "OPEN" };
    const pulls = await prisma.pullRequest.findMany({
      where: { ...who, ...stateWhere },
      orderBy: { updatedAt: "desc" },
      take: LIMIT * 2,
      include: {
        repo: repoSelect,
        author: { select: { handle: true } },
        assignee: { select: { handle: true } },
        labels: labelsSelect,
        _count: { select: { comments: true } },
      },
    });
    return {
      pulls: pulls
        .filter((p) => canRead(p.repo, userId))
        .slice(0, LIMIT)
        .map((p) => ({
          repo: repoRef(p.repo),
          number: p.number,
          title: p.title,
          state: p.state.toLowerCase(),
          isDraft: p.isDraft,
          author: p.author.handle,
          assignee: p.assignee?.handle ?? null,
          labels: p.labels.map((l) => l.label),
          comments: p._count.comments,
          fromBranch: p.fromBranch,
          toBranch: p.toBranch,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
    };
  });
}
