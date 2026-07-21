import type { CollaboratorRole, RepoVisibility } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildStorageKey, createBareRepo, inspectBareRepo, moveBareRepo, removeBareRepo } from "../git-storage.js";
import { prisma } from "../prisma.js";
import {
  addCollaboratorBodySchema,
  createRepoBodySchema,
  renameRepoBodySchema,
  updateRepoBodySchema,
} from "../validation.js";

function toApiVisibility(v: RepoVisibility) {
  return v === "PUBLIC" ? "public" : "private";
}

function fromApiVisibility(v: "public" | "private"): RepoVisibility {
  return v === "public" ? "PUBLIC" : "PRIVATE";
}

function viewerId(request: FastifyRequest): string | undefined {
  const u = (request as { user?: { sub: string } }).user;
  return u?.sub;
}

function canViewRepo(
  id: string | undefined,
  repo: { ownerId: string; visibility: RepoVisibility; collaborators?: Array<{ userId: string }> },
): boolean {
  if (repo.visibility === "PUBLIC") {
    return true;
  }
  if (id === repo.ownerId) {
    return true;
  }
  return repo.collaborators?.some((c) => c.userId === id) ?? false;
}

function toDbCollaboratorRole(role: "reader" | "writer"): CollaboratorRole {
  return role === "writer" ? "WRITER" : "READER";
}

function fromDbCollaboratorRole(role: CollaboratorRole): "reader" | "writer" {
  return role === "WRITER" ? "writer" : "reader";
}

function repoResponse(r: {
  id: string;
  name: string;
  description: string | null;
  visibility: RepoVisibility;
  storageKey: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  owner?: { handle: string };
  topics?: Array<{ topic: string }>;
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: toApiVisibility(r.visibility),
    storageKey: r.storageKey,
    ownerId: r.ownerId,
    ownerHandle: r.owner?.handle,
    fullName: r.owner ? `${r.owner.handle}/${r.name}` : undefined,
    // Sorted topic slugs; empty when the relation wasn't included or none set.
    topics: (r.topics ?? []).map((t) => t.topic),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Prisma include fragment for the sorted topic set — shared by every route that
// returns a repoResponse so topic chips render consistently everywhere.
const topicsInclude = { topics: { orderBy: { topic: "asc" }, select: { topic: true } } } as const;

export async function repoRoutes(app: FastifyInstance) {
  app.post(
    "/repos",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = createRepoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const name = parsed.data.name.toLowerCase();
      const ownerId = request.user.sub;
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { handle: true },
      });
      if (!owner) {
        return reply.status(404).send({ error: "Owner account not found" });
      }
      const storageKey = buildStorageKey(owner.handle, name);
      let bareRepoCreated = false;

      try {
        await createBareRepo(storageKey);
        bareRepoCreated = true;
        const repo = await prisma.repo.create({
          data: {
            name,
            description: parsed.data.description?.trim() || null,
            visibility: fromApiVisibility(parsed.data.visibility),
            storageKey,
            ownerId,
          },
          include: { owner: { select: { handle: true } } },
        });
        return reply.status(201).send(repoResponse(repo));
      } catch (e: unknown) {
        if (bareRepoCreated) {
          await removeBareRepo(storageKey);
        }
        if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
          return reply.status(409).send({ error: "You already have a repository with this name" });
        }
        throw e;
      }
    },
  );

  app.get(
    "/repos/mine",
    { preHandler: [app.authenticate] },
    async (request) => {
      const repos = await prisma.repo.findMany({
        where: { ownerId: request.user.sub },
        orderBy: { updatedAt: "desc" },
        include: { owner: { select: { handle: true } }, ...topicsInclude },
      });
      return { repos: repos.map(repoResponse) };
    },
  );

  app.get(
    "/repos/collaborating",
    { preHandler: [app.authenticate] },
    async (request) => {
      const collabs = await prisma.repoCollaborator.findMany({
        where: { userId: request.user.sub },
        include: {
          repo: { include: { owner: { select: { handle: true } }, ...topicsInclude } },
        },
        orderBy: { repo: { updatedAt: "desc" } },
      });
      return { repos: collabs.map((c) => repoResponse(c.repo)) };
    },
  );

  app.get(
    "/repos/:handle/:name",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };
      const handle = handleParam;
      const name = nameParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: { name, owner: { handle: handle.toLowerCase() } },
        include: {
          owner: { select: { handle: true } },
          collaborators: { select: { userId: true } },
          ...topicsInclude,
        },
      });
      if (!repo || !canViewRepo(viewerId(request), repo)) {
        return reply.status(404).send({ error: "Repository not found" });
      }
      return repoResponse(repo);
    },
  );

  app.get(
    "/users/:handle/repos",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle: handleParam } = request.params as { handle: string };
      const handle = handleParam.toLowerCase();
      const owner = await prisma.user.findUnique({ where: { handle } });
      if (!owner) {
        return reply.status(404).send({ error: "User not found" });
      }

      const v = viewerId(request);
      const isOwner = v === owner.id;

      const repos = await prisma.repo.findMany({
        where: isOwner
          ? { ownerId: owner.id }
          : {
              ownerId: owner.id,
              OR: [{ visibility: "PUBLIC" }, { collaborators: { some: { userId: v } } }],
            },
        orderBy: { updatedAt: "desc" },
        include: { owner: { select: { handle: true } }, ...topicsInclude },
      });
      return { repos: repos.map(repoResponse) };
    },
  );

  app.patch(
    "/repos/:name",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = updateRepoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { name: nameParam } = request.params as { name: string };
      const name = nameParam.toLowerCase();
      const ownerId = request.user.sub;

      const existing = await prisma.repo.findFirst({
        where: { ownerId, name },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      const { description, visibility } = parsed.data;
      const descriptionValue =
        description === undefined ? undefined : description === null ? null : description.trim() || null;

      const data: { description?: string | null; visibility?: RepoVisibility } = {};
      if (descriptionValue !== undefined) {
        data.description = descriptionValue;
      }
      if (visibility !== undefined) {
        data.visibility = fromApiVisibility(visibility);
      }

      if (Object.keys(data).length === 0) {
        const repo = await prisma.repo.findFirstOrThrow({
          where: { id: existing.id },
          include: { owner: { select: { handle: true } }, ...topicsInclude },
        });
        return repoResponse(repo);
      }

      const repo = await prisma.repo.update({
        where: { id: existing.id },
        data,
        include: { owner: { select: { handle: true } }, ...topicsInclude },
      });
      return repoResponse(repo);
    },
  );

  app.patch(
    "/repos/:name/rename",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = renameRepoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { name: currentNameParam } = request.params as { name: string };
      const currentName = currentNameParam.toLowerCase();
      const newName = parsed.data.name.toLowerCase();
      const ownerId = request.user.sub;

      const existing = await prisma.repo.findFirst({
        where: { ownerId, name: currentName },
        include: { owner: { select: { handle: true } }, ...topicsInclude },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      if (currentName === newName) {
        return repoResponse(existing);
      }

      const ownerHandle = existing.owner?.handle;
      if (!ownerHandle) {
        return reply.status(500).send({ error: "Owner handle missing" });
      }

      const newStorageKey = existing.storageKey ? buildStorageKey(ownerHandle, newName) : null;
      let moved = false;

      try {
        if (existing.storageKey && newStorageKey) {
          await moveBareRepo(existing.storageKey, newStorageKey);
          moved = true;
        }

        const updated = await prisma.repo.update({
          where: { id: existing.id },
          data: {
            name: newName,
            storageKey: newStorageKey,
          },
          include: { owner: { select: { handle: true } }, ...topicsInclude },
        });
        return repoResponse(updated);
      } catch (e: unknown) {
        if (moved && existing.storageKey && newStorageKey) {
          await moveBareRepo(newStorageKey, existing.storageKey).catch(() => undefined);
        }
        if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
          return reply.status(409).send({ error: "You already have a repository with this name" });
        }
        throw e;
      }
    },
  );

  app.get(
    "/repos/:name/collaborators",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { name: nameParam } = request.params as { name: string };
      const name = nameParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: { ownerId: request.user.sub, name },
        include: {
          collaborators: {
            include: {
              user: { select: { id: true, handle: true, email: true, displayName: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!repo) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      return {
        collaborators: repo.collaborators.map((c: (typeof repo.collaborators)[number]) => ({
          id: c.id,
          role: fromDbCollaboratorRole(c.role),
          createdAt: c.createdAt.toISOString(),
          user: c.user,
        })),
      };
    },
  );

  app.post(
    "/repos/:name/collaborators",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const parsed = addCollaboratorBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { name: nameParam } = request.params as { name: string };
      const name = nameParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: { ownerId: request.user.sub, name },
      });
      if (!repo) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      const collaboratorUser = await prisma.user.findUnique({
        where: { handle: parsed.data.handle.toLowerCase() },
      });
      if (!collaboratorUser) {
        return reply.status(404).send({ error: "User not found" });
      }
      if (collaboratorUser.id === repo.ownerId) {
        return reply.status(400).send({ error: "Owner is already implicitly a collaborator" });
      }

      const role = toDbCollaboratorRole(parsed.data.role);
      const collaborator = await prisma.repoCollaborator.upsert({
        where: {
          repoId_userId: {
            repoId: repo.id,
            userId: collaboratorUser.id,
          },
        },
        create: {
          repoId: repo.id,
          userId: collaboratorUser.id,
          role,
        },
        update: { role },
        include: {
          user: { select: { id: true, handle: true, email: true, displayName: true } },
        },
      });

      return reply.status(201).send({
        id: collaborator.id,
        role: fromDbCollaboratorRole(collaborator.role),
        createdAt: collaborator.createdAt.toISOString(),
        user: collaborator.user,
      });
    },
  );

  app.delete(
    "/repos/:name/collaborators/:handle",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { name: nameParam, handle: handleParam } = request.params as { name: string; handle: string };
      const name = nameParam.toLowerCase();
      const handle = handleParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: { ownerId: request.user.sub, name },
      });
      if (!repo) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      const user = await prisma.user.findUnique({ where: { handle } });
      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      const existing = await prisma.repoCollaborator.findUnique({
        where: { repoId_userId: { repoId: repo.id, userId: user.id } },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Collaborator not found" });
      }

      await prisma.repoCollaborator.delete({
        where: { repoId_userId: { repoId: repo.id, userId: user.id } },
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    "/repos/:name",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { name: nameParam } = request.params as { name: string };
      const name = nameParam.toLowerCase();
      const ownerId = request.user.sub;

      const existing = await prisma.repo.findFirst({
        where: { ownerId, name },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      await prisma.repo.delete({ where: { id: existing.id } });

      if (existing.storageKey) {
        await removeBareRepo(existing.storageKey);
      }

      return reply.status(204).send();
    },
  );

  // Returns owner + collaborators — anyone who can be assigned to issues.
  // Visible to all repo readers (no auth requirement beyond read access).
  app.get(
    "/repos/:handle/:name/members",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };
      const handle = handleParam.toLowerCase();
      const name = nameParam.toLowerCase();
      const viewerId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await prisma.repo.findFirst({
        where: { name, owner: { handle } },
        include: {
          owner: { select: { id: true, handle: true, displayName: true } },
          collaborators: {
            include: { user: { select: { id: true, handle: true, displayName: true } } },
          },
        },
      });
      if (!repo) return reply.status(404).send({ error: "Not found" });
      if (repo.visibility === "PRIVATE") {
        const isReader =
          viewerId === repo.ownerId || repo.collaborators.some((c) => c.userId === viewerId);
        if (!isReader) return reply.status(404).send({ error: "Not found" });
      }

      const members = [
        { id: repo.owner.id, handle: repo.owner.handle, displayName: repo.owner.displayName, role: "owner" as const },
        ...repo.collaborators.map((c) => ({
          id: c.user.id,
          handle: c.user.handle,
          displayName: c.user.displayName,
          role: c.role === "WRITER" ? "writer" as const : "reader" as const,
        })),
      ];
      return { members };
    },
  );

  app.get(
    "/repos/:handle/:name/storage",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };
      const handle = handleParam.toLowerCase();
      const name = nameParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: { name, owner: { handle } },
      });

      if (!repo || repo.ownerId !== request.user.sub) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      if (!repo.storageKey) {
        return reply.status(404).send({ error: "Storage key not set for this repository" });
      }

      const inspection = await inspectBareRepo(repo.storageKey);
      return inspection;
    },
  );
}
