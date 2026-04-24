import type { RepoVisibility } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { createRepoBodySchema, updateRepoBodySchema } from "../validation.js";

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
  repo: { ownerId: string; visibility: RepoVisibility },
): boolean {
  if (repo.visibility === "PUBLIC") {
    return true;
  }
  return id === repo.ownerId;
}

function repoResponse(r: {
  id: string;
  name: string;
  description: string | null;
  visibility: RepoVisibility;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  owner?: { handle: string };
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: toApiVisibility(r.visibility),
    ownerId: r.ownerId,
    ownerHandle: r.owner?.handle,
    fullName: r.owner ? `${r.owner.handle}/${r.name}` : undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

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

      try {
        const repo = await prisma.repo.create({
          data: {
            name,
            description: parsed.data.description?.trim() || null,
            visibility: fromApiVisibility(parsed.data.visibility),
            ownerId,
          },
          include: { owner: { select: { handle: true } } },
        });
        return reply.status(201).send(repoResponse(repo));
      } catch (e: unknown) {
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
        include: { owner: { select: { handle: true } } },
      });
      return { repos: repos.map(repoResponse) };
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
        include: { owner: { select: { handle: true } } },
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
        where: {
          ownerId: owner.id,
          ...(!isOwner ? { visibility: "PUBLIC" as const } : {}),
        },
        orderBy: { updatedAt: "desc" },
        include: { owner: { select: { handle: true } } },
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
          include: { owner: { select: { handle: true } } },
        });
        return repoResponse(repo);
      }

      const repo = await prisma.repo.update({
        where: { id: existing.id },
        data,
        include: { owner: { select: { handle: true } } },
      });
      return repoResponse(repo);
    },
  );
}
