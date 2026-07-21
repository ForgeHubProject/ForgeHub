import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";

function viewerId(request: { user?: { sub: string } }): string | undefined {
  return request.user?.sub;
}

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/search",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { q, type = "repos" } = request.query as { q?: string; type?: string };

      if (!q || q.trim().length < 2) {
        return reply.status(400).send({ error: "Query must be at least 2 characters" });
      }

      const term = q.trim();
      const vid = viewerId(request as { user?: { sub: string } });

      const visibilityFilter = {
        OR: [
          { visibility: "PUBLIC" as const },
          ...(vid ? [
            { ownerId: vid },
            { collaborators: { some: { userId: vid } } },
          ] : []),
        ],
      };

      if (type === "issues") {
        const issues = await prisma.issue.findMany({
          where: {
            AND: [
              { OR: [{ title: { contains: term } }, { body: { contains: term } }] },
              { repo: visibilityFilter },
            ],
          },
          include: {
            repo: { include: { owner: { select: { handle: true } } } },
            author: { select: { handle: true, displayName: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 25,
        });

        return {
          type: "issues",
          results: issues.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            state: i.state.toLowerCase(),
            author: i.author.handle,
            createdAt: i.createdAt.toISOString(),
            updatedAt: i.updatedAt.toISOString(),
            repo: {
              name: i.repo.name,
              ownerHandle: i.repo.owner.handle,
            },
          })),
        };
      }

      if (type === "users") {
        const users = await prisma.user.findMany({
          where: {
            OR: [
              { handle: { contains: term } },
              { displayName: { contains: term } },
            ],
          },
          select: { id: true, handle: true, displayName: true, createdAt: true },
          take: 25,
        });

        return {
          type: "users",
          results: users.map((u) => ({
            id: u.id,
            handle: u.handle,
            displayName: u.displayName,
            createdAt: u.createdAt.toISOString(),
          })),
        };
      }

      // Default: repos. `topic:<slug>` tokens filter by topic (repeatable, ANDed);
      // remaining free text still matches name/description. This is how a topic
      // chip's click-through ("topic:react") narrows to repos carrying that topic.
      const topicFilters = [...term.matchAll(/topic:([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase());
      const textTerm = term.replace(/topic:[a-z0-9-]+/gi, "").trim();

      const repoConditions: Record<string, unknown>[] = [
        visibilityFilter,
        ...topicFilters.map((topic) => ({ topics: { some: { topic } } })),
      ];
      if (textTerm.length > 0) {
        repoConditions.push({ OR: [{ name: { contains: textTerm } }, { description: { contains: textTerm } }] });
      }

      const repos = await prisma.repo.findMany({
        where: { AND: repoConditions },
        include: {
          owner: { select: { handle: true } },
          topics: { orderBy: { topic: "asc" }, select: { topic: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });

      return {
        type: "repos",
        results: repos.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          visibility: r.visibility === "PUBLIC" ? "public" : "private",
          ownerHandle: r.owner.handle,
          topics: r.topics.map((t) => t.topic),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  );
}
