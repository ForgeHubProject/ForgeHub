import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { createTag, tagExists } from "../git-utils.js";

const releaseInclude = { author: { select: { handle: true } } } as const;

function formatRelease(r: {
  id: string;
  tagName: string;
  name: string;
  body: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  author: { handle: string };
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    tagName: r.tagName,
    name: r.name,
    body: r.body,
    isDraft: r.isDraft,
    isPrerelease: r.isPrerelease,
    author: r.author.handle,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function releaseRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/releases
  app.get("/repos/:handle/:name/releases", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const isWriter = canWrite(repo, userId);
    const releases = await prisma.release.findMany({
      where: { repoId: repo.id, ...(isWriter ? {} : { isDraft: false }) },
      include: releaseInclude,
      orderBy: { createdAt: "desc" },
    });
    return { releases: releases.map(formatRelease) };
  });

  // GET /repos/:handle/:name/releases/latest
  app.get("/repos/:handle/:name/releases/latest", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const release = await prisma.release.findFirst({
      where: { repoId: repo.id, isDraft: false, isPrerelease: false },
      include: releaseInclude,
      orderBy: { createdAt: "desc" },
    });
    if (!release) return reply.status(404).send({ error: "No release found" });
    return formatRelease(release);
  });

  // GET /repos/:handle/:name/releases/tags/:tag
  app.get("/repos/:handle/:name/releases/tags/:tag", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, tag } = request.params as { handle: string; name: string; tag: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const release = await prisma.release.findFirst({
      where: { repoId: repo.id, tagName: tag },
      include: releaseInclude,
    });
    if (!release) return reply.status(404).send({ error: "Release not found" });
    if (release.isDraft && !canWrite(repo, userId)) return reply.status(404).send({ error: "Release not found" });
    return formatRelease(release);
  });

  // POST /repos/:handle/:name/releases
  app.post("/repos/:handle/:name/releases", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const {
      tagName,
      targetCommitish,
      name: releaseName,
      body,
      isDraft = false,
      isPrerelease = false,
    } = request.body as {
      tagName?: string;
      targetCommitish?: string;
      name?: string;
      body?: string;
      isDraft?: boolean;
      isPrerelease?: boolean;
    };

    if (!tagName || !/^[\w/._-]+$/.test(tagName)) {
      return reply.status(400).send({ error: "tagName is required and must be a valid tag name" });
    }

    // Check for duplicate release
    const existing = await prisma.release.findFirst({ where: { repoId: repo.id, tagName } });
    if (existing) return reply.status(409).send({ error: "A release for this tag already exists" });

    // Create the git tag if it doesn't exist yet
    if (repo.storageKey) {
      const exists = await tagExists(repo.storageKey, tagName);
      if (!exists) {
        if (!targetCommitish) {
          return reply.status(422).send({ error: "Tag does not exist; provide targetCommitish to create it" });
        }
        try {
          await createTag(repo.storageKey, tagName, targetCommitish, releaseName ?? tagName);
        } catch (e) {
          return reply.status(422).send({ error: `Could not create tag: ${String(e)}` });
        }
      }
    }

    const release = await prisma.release.create({
      data: {
        repoId: repo.id,
        tagName,
        name: releaseName ?? tagName,
        body: body ?? null,
        isDraft,
        isPrerelease,
        authorId: userId,
      },
      include: releaseInclude,
    });

    return reply.status(201).send(formatRelease(release));
  });

  // PATCH /repos/:handle/:name/releases/:id
  app.patch("/repos/:handle/:name/releases/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    const { name: releaseName, body, isDraft, isPrerelease } = request.body as {
      name?: string;
      body?: string;
      isDraft?: boolean;
      isPrerelease?: boolean;
    };

    const updated = await prisma.release.update({
      where: { id },
      data: {
        ...(releaseName !== undefined ? { name: releaseName } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(isDraft !== undefined ? { isDraft } : {}),
        ...(isPrerelease !== undefined ? { isPrerelease } : {}),
      },
      include: releaseInclude,
    });

    return formatRelease(updated);
  });

  // DELETE /repos/:handle/:name/releases/:id  (leaves git tag intact)
  app.delete("/repos/:handle/:name/releases/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    await prisma.release.delete({ where: { id } });
    return reply.status(204).send();
  });
}
