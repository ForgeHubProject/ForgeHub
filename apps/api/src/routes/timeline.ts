import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";

type RawEvent = {
  id: string;
  kind: string;
  actorId: string;
  data: string;
  createdAt: Date;
};

/** Shape a stored event for the wire, lifting the denormalized actor handle out of `data`. */
function formatEvent(e: RawEvent) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.data) as Record<string, unknown>;
  } catch { /* keep empty on malformed json */ }
  const { actorHandle, ...rest } = payload;
  return {
    id: e.id,
    kind: e.kind,
    actor: typeof actorHandle === "string" ? actorHandle : "ghost",
    createdAt: e.createdAt.toISOString(),
    data: rest,
  };
}

export async function timelineRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/issues/:number/timeline
  app.get("/repos/:handle/:name/issues/:number/timeline", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) }, select: { id: true } });
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const events = await prisma.timelineEvent.findMany({
      where: { repoId: repo.id, subjectType: "ISSUE", subjectNumber: Number(number) },
      orderBy: { createdAt: "asc" },
    });
    return { events: events.map(formatEvent) };
  });

  // GET /repos/:handle/:name/pulls/:number/timeline
  app.get("/repos/:handle/:name/pulls/:number/timeline", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) }, select: { id: true } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const events = await prisma.timelineEvent.findMany({
      where: { repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: Number(number) },
      orderBy: { createdAt: "asc" },
    });
    return { events: events.map(formatEvent) };
  });
}
