import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { updateTopicsBodySchema } from "../validation.js";

/** Load a repo's topics as a sorted, lowercased string array. */
export async function repoTopics(repoId: string): Promise<string[]> {
  const rows = await prisma.repoTopic.findMany({
    where: { repoId },
    orderBy: { topic: "asc" },
    select: { topic: true },
  });
  return rows.map((r) => r.topic);
}

export async function topicRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/topics — visible to anyone who can read the repo.
  app.get("/repos/:handle/:name/topics", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    return { topics: await repoTopics(repo.id) };
  });

  // PUT /repos/:handle/:name/topics — replace the whole set (writer-gated).
  app.put("/repos/:handle/:name/topics", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const parsed = updateTopicsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid topics", details: parsed.error.flatten() });
    }

    // Dedupe while preserving the validated lowercase-kebab shape, then cap at 20.
    const unique = [...new Set(parsed.data.topics)].slice(0, 20);

    // Replace the set atomically: clear then recreate. Small N, so this is simplest.
    await prisma.$transaction([
      prisma.repoTopic.deleteMany({ where: { repoId: repo.id } }),
      ...(unique.length > 0
        ? [prisma.repoTopic.createMany({ data: unique.map((topic) => ({ repoId: repo.id, topic })) })]
        : []),
    ]);

    return { topics: await repoTopics(repo.id) };
  });
}
