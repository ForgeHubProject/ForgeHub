import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

function formatLabel(label: { id: string; name: string; color: string; description: string | null; createdAt: Date }) {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    createdAt: label.createdAt.toISOString(),
  };
}

export async function labelRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to mutate labels; session/JWT auth is unscoped
  // and no-ops this guard (issue #87). Route bodies keep their canWrite check.
  const write = app.requireScope("repo:write");

  // GET /repos/:handle/:name/labels
  app.get("/repos/:handle/:name/labels", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const labels = await prisma.label.findMany({
      where: { repoId: repo.id },
      orderBy: { createdAt: "asc" },
    });

    return { labels: labels.map(formatLabel) };
  });

  // POST /repos/:handle/:name/labels
  app.post("/repos/:handle/:name/labels", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const { name: labelName, color, description } = request.body as {
      name?: string;
      color?: string;
      description?: string;
    };

    if (!labelName || labelName.trim().length === 0 || labelName.trim().length > 50) {
      return reply.status(400).send({ error: "name is required (1–50 characters)" });
    }
    if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) {
      return reply.status(400).send({ error: "color must be a 6-character hex string (e.g. 'd73a4a')" });
    }

    // Check for duplicate name in this repo
    const existing = await prisma.label.findFirst({
      where: { repoId: repo.id, name: labelName.trim() },
    });
    if (existing) return reply.status(409).send({ error: "A label with this name already exists in the repository" });

    const label = await prisma.label.create({
      data: {
        repoId: repo.id,
        name: labelName.trim(),
        color,
        description: description?.trim() || null,
      },
    });

    return reply.status(201).send(formatLabel(label));
  });

  // PATCH /repos/:handle/:name/labels/:labelId
  app.patch("/repos/:handle/:name/labels/:labelId", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, labelId } = request.params as { handle: string; name: string; labelId: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const label = await prisma.label.findFirst({ where: { id: labelId, repoId: repo.id } });
    if (!label) return reply.status(404).send({ error: "Label not found" });

    const { name: labelName, color, description } = request.body as {
      name?: string;
      color?: string;
      description?: string;
    };

    if (labelName !== undefined && (labelName.trim().length === 0 || labelName.trim().length > 50)) {
      return reply.status(400).send({ error: "name must be 1–50 characters" });
    }
    if (color !== undefined && !/^[0-9a-fA-F]{6}$/.test(color)) {
      return reply.status(400).send({ error: "color must be a 6-character hex string" });
    }

    const updated = await prisma.label.update({
      where: { id: label.id },
      data: {
        ...(labelName !== undefined ? { name: labelName.trim() } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(description !== undefined ? { description: description.trim() || null } : {}),
      },
    });

    return formatLabel(updated);
  });

  // DELETE /repos/:handle/:name/labels/:labelId
  app.delete("/repos/:handle/:name/labels/:labelId", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, labelId } = request.params as { handle: string; name: string; labelId: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const label = await prisma.label.findFirst({ where: { id: labelId, repoId: repo.id } });
    if (!label) return reply.status(404).send({ error: "Label not found" });

    await prisma.label.delete({ where: { id: label.id } });

    return reply.status(204).send();
  });
}
