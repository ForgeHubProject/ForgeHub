import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { cloneMirror } from "../git-utils.js";
import { randomBytes } from "node:crypto";

export async function forkRoutes(app: FastifyInstance) {
  // POST /repos/:handle/:name/fork
  app.post("/repos/:handle/:name/fork", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId === userId) return reply.status(400).send({ error: "Cannot fork your own repository" });

    // Check if user already has a repo with this name; suffix with -fork if needed
    let forkName = repo.name;
    const existing = await prisma.repo.findFirst({ where: { ownerId: userId, name: forkName } });
    if (existing) forkName = `${repo.name}-fork`;

    let forkStorageKey: string | null = null;
    if (repo.storageKey) {
      forkStorageKey = `forks/${randomBytes(12).toString("hex")}`;
      await cloneMirror(repo.storageKey, forkStorageKey);
    }

    const fork = await prisma.repo.create({
      data: {
        name: forkName,
        description: repo.description ? `Fork of ${handle}/${repo.name}. ${repo.description}` : `Fork of ${handle}/${repo.name}`,
        visibility: repo.visibility,
        ownerId: userId,
        storageKey: forkStorageKey,
      },
    });

    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true } });

    return reply.status(201).send({
      id: fork.id,
      name: fork.name,
      owner: owner?.handle ?? userId,
      description: fork.description,
      visibility: fork.visibility,
      createdAt: fork.createdAt.toISOString(),
    });
  });
}
