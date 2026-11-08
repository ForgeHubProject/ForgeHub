import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { FORMAT_FAMILIES, fillMissingFormats, parseFormats } from "../repo-formats.js";
import { repoCardInclude, repoResponse } from "./repos.js";

const PER_PAGE = 20;
const PUBLIC = { visibility: "PUBLIC" as const };

/**
 * Discovery (#257): Explore's public repositories (popular or recently
 * updated, by format and by topic), the popular topics, and how many public
 * repositories hold each format family. Only public repositories are listed.
 */
export async function exploreRoutes(app: FastifyInstance) {
  // GET /explore/repos?sort=stars|updated&format=<family>&topic=<slug>&page=N
  app.get("/explore/repos", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { sort, format, topic, page: pageQ } = request.query as { sort?: string; format?: string; topic?: string; page?: string };
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const family = format ? FORMAT_FAMILIES[format] : undefined;
    if (format && !family) return reply.status(400).send({ error: `Unknown format "${format}"` });

    await fillMissingFormats(PUBLIC);
    const where = {
      ...PUBLIC,
      ...(family ? { OR: family.map((id) => ({ formats: { contains: JSON.stringify(id) } })) } : {}),
      ...(topic ? { topics: { some: { topic: topic.toLowerCase() } } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.repo.findMany({
        where,
        include: repoCardInclude,
        orderBy: sort === "updated" ? [{ updatedAt: "desc" }] : [{ stars: { _count: "desc" } }, { updatedAt: "desc" }],
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
      }),
      prisma.repo.count({ where }),
    ]);
    return {
      repos: rows.map((r) => ({ ...repoResponse(r), formats: parseFormats(r.formats) })),
      total,
      hasMore: page * PER_PAGE < total,
    };
  });

  // GET /explore/topics — the topics on the most public repositories.
  app.get("/explore/topics", { preHandler: [app.optionalAuthenticate] }, async () => {
    const rows = await prisma.repoTopic.groupBy({
      by: ["topic"],
      where: { repo: PUBLIC },
      _count: { topic: true },
      orderBy: [{ _count: { topic: "desc" } }, { topic: "asc" }],
      take: 30,
    });
    return { topics: rows.map((r) => ({ topic: r.topic, count: r._count.topic })) };
  });

  // GET /explore/formats — public repositories per format family.
  app.get("/explore/formats", { preHandler: [app.optionalAuthenticate] }, async () => {
    await fillMissingFormats(PUBLIC);
    const rows = await prisma.repo.findMany({ where: PUBLIC, select: { formats: true } });
    const held = rows.map((r) => new Set(parseFormats(r.formats)));
    return {
      formats: Object.entries(FORMAT_FAMILIES).map(([id, ids]) => ({
        id,
        count: held.filter((set) => ids.some((x) => set.has(x))).length,
      })),
    };
  });
}
