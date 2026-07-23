import type { CollaboratorRole, RepoVisibility } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildStorageKey, createBareRepo, inspectBareRepo, moveBareRepo, removeBareRepo } from "../git-storage.js";
import { detectRepoLicense } from "../license.js";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude, repoByOwningHandleWhere } from "../repo-access.js";
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

/**
 * SSH clone config (issue #116) surfaced on every repo payload so the clone box
 * can offer an SSH tab. The port comes from server config (FORGEHUB_SSH_PORT);
 * null means the SSH transport is disabled and the web hides the SSH option.
 * `sshHost` is an optional explicit override (FORGEHUB_SSH_HOST) — when null the
 * web falls back to the browser's current hostname.
 */
function sshCloneConfig(): { sshPort: number | null; sshHost: string | null } {
  const portRaw = process.env["FORGEHUB_SSH_PORT"];
  if (!portRaw || !portRaw.trim()) return { sshPort: null, sshHost: null };
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { sshPort: null, sshHost: null };
  return { sshPort: port, sshHost: process.env["FORGEHUB_SSH_HOST"]?.trim() || null };
}

/** A repo reference in a fork chain: the owner handle + repo name to link to. */
type ForkRef = { handle: string; name: string };

/**
 * Fork-lineage fields for the repo header (issue #113). `parent` is the direct
 * upstream, `source` the root of the chain, and `forkCount` the number of direct
 * forks — all already visibility-filtered by the caller (a private parent the
 * viewer can't read is passed as null, never leaked). Defaults keep every
 * non-detail payload stable: not a fork, no forks.
 */
type ForkLineage = { parent: ForkRef | null; source: ForkRef | null; forkCount: number };

export function repoResponse(
  r: {
    id: string;
    name: string;
    description: string | null;
    visibility: RepoVisibility;
    storageKey: string | null;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
    owner?: { handle: string };
    // The OWNING namespace when the repo belongs to an org (issue #114). When set,
    // its handle — not the creator's — is the one shown in URLs / fullName. `orgId`
    // is surfaced so the web can badge a repo as org-owned.
    orgId?: string | null;
    org?: { handle: string } | null;
    topics?: Array<{ topic: string }>;
  },
  lineage?: ForkLineage,
) {
  // Owning handle: the org's when org-owned, otherwise the creating user's.
  const ownerHandle = r.org?.handle ?? r.owner?.handle;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: toApiVisibility(r.visibility),
    storageKey: r.storageKey,
    ownerId: r.ownerId,
    orgId: r.orgId ?? null,
    ownerHandle,
    fullName: ownerHandle ? `${ownerHandle}/${r.name}` : undefined,
    // Sorted topic slugs; empty when the relation wasn't included or none set.
    topics: (r.topics ?? []).map((t) => t.topic),
    // Fork lineage — populated only on the repo detail payload (issue #113).
    parent: lineage?.parent ?? null,
    source: lineage?.source ?? null,
    forkCount: lineage?.forkCount ?? 0,

    ...sshCloneConfig(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Prisma include fragment for the sorted topic set — shared by every route that
// returns a repoResponse so topic chips render consistently everywhere.
const topicsInclude = { topics: { orderBy: { topic: "asc" }, select: { topic: true } } } as const;

// Owner + owning-org handle + topics: the standard include for a repoResponse so
// both personal and org-owned repos render their correct owning handle (issue #114).
export const repoCardInclude = {
  owner: { select: { handle: true } },
  org: { select: { handle: true } },
  ...topicsInclude,
} as const;

/**
 * Resolve a repo's fork lineage for the header (issue #113), scoped to what
 * `viewerId` may see. Walks up the `forkedFrom` chain, stopping at the first
 * ancestor the viewer can't read so a private upstream's existence never leaks;
 * `parent` is the immediate readable upstream and `source` the highest readable
 * ancestor (the root of the chain). `forkCount` counts only direct forks the
 * viewer is allowed to see.
 */
async function resolveForkLineage(
  repo: { id: string; forkedFromId: string | null },
  viewerId: string | undefined,
): Promise<{ parent: { handle: string; name: string } | null; source: { handle: string; name: string } | null; forkCount: number }> {
  const forkWhere = viewerId
    ? {
        forkedFromId: repo.id,
        OR: [
          { visibility: "PUBLIC" as const },
          { ownerId: viewerId },
          { collaborators: { some: { userId: viewerId } } },
        ],
      }
    : { forkedFromId: repo.id, visibility: "PUBLIC" as const };
  const forkCount = await prisma.repo.count({ where: forkWhere });

  let parent: { handle: string; name: string } | null = null;
  let source: { handle: string; name: string } | null = null;
  const seen = new Set<string>([repo.id]);
  let currentParentId = repo.forkedFromId;
  while (currentParentId && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    const anc = await prisma.repo.findUnique({
      where: { id: currentParentId },
      include: { owner: { select: { handle: true } }, collaborators: { select: { userId: true } } },
    });
    if (!anc || !canViewRepo(viewerId, anc)) break;
    const ref = { handle: anc.owner.handle, name: anc.name };
    if (!parent) parent = ref;
    source = ref;
    currentParentId = anc.forkedFromId;
  }
  return { parent, source, forkCount };
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
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { handle: true },
      });
      if (!owner) {
        return reply.status(404).send({ error: "Owner account not found" });
      }

      // Resolve the target owning namespace (issue #114). No `owner`, or the
      // caller's own handle, ⇒ a personal repo. Otherwise the handle must name an
      // org the caller belongs to; v0 lets ANY org member (OWNER or MEMBER) create
      // repos in the org. The storageKey — and thus the URL namespace — is keyed on
      // the OWNING handle (org handle for org repos), which is also what guarantees
      // per-namespace name uniqueness (storageKey is globally unique).
      let orgId: string | null = null;
      let namespaceHandle = owner.handle;
      const targetHandle = parsed.data.owner?.toLowerCase();
      if (targetHandle && targetHandle !== owner.handle) {
        const org = await prisma.organization.findUnique({
          where: { handle: targetHandle },
          select: { id: true, handle: true },
        });
        if (!org) {
          return reply.status(404).send({ error: "Organization not found" });
        }
        const membership = await prisma.orgMembership.findUnique({
          where: { orgId_userId: { orgId: org.id, userId: ownerId } },
        });
        if (!membership) {
          return reply.status(403).send({ error: "You are not a member of this organization" });
        }
        orgId = org.id;
        namespaceHandle = org.handle;
      }

      const storageKey = buildStorageKey(namespaceHandle, name);
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
            orgId,
          },
          include: { owner: { select: { handle: true } }, org: { select: { handle: true } } },
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
      // "Your repositories" = personal repos (orgId: null). Org repos the caller
      // created are reachable from the org's profile (issue #114).
      const repos = await prisma.repo.findMany({
        where: { ownerId: request.user.sub, orgId: null },
        orderBy: { updatedAt: "desc" },
        include: repoCardInclude,
      });
      return { repos: repos.map((r) => repoResponse(r)) };
    },
  );

  app.get(
    "/repos/collaborating",
    { preHandler: [app.authenticate] },
    async (request) => {
      const collabs = await prisma.repoCollaborator.findMany({
        where: { userId: request.user.sub },
        include: {
          repo: { include: repoCardInclude },
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
      const name = nameParam.toLowerCase();

      // Resolve under the owning handle (user OR org) and fetch with the full access
      // include so org owners + team members can see private org repos (issue #114).
      const repo = await prisma.repo.findFirst({
        where: repoByOwningHandleWhere(handleParam, name),
        include: { ...repoAccessInclude, owner: { select: { handle: true } }, ...topicsInclude },
      });
      const viewer = viewerId(request);
      if (!repo || !canRead(repo, viewer)) {
        return reply.status(404).send({ error: "Repository not found" });
      }
      // Best-effort SPDX detection at the default branch (cached per head sha),
      // plus visibility-scoped fork lineage for the header (issue #113).
      const [license, lineage] = await Promise.all([
        detectRepoLicense(repo.storageKey),
        resolveForkLineage(repo, viewer),
      ]);
      return { ...repoResponse(repo, lineage), license };
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

      // A user profile lists that user's PERSONAL repos only (orgId: null); repos
      // they created inside an org live on the org's profile (issue #114).
      const repos = await prisma.repo.findMany({
        where: isOwner
          ? { ownerId: owner.id, orgId: null }
          : {
              ownerId: owner.id,
              orgId: null,
              OR: [{ visibility: "PUBLIC" }, { collaborators: { some: { userId: v } } }],
            },
        orderBy: { updatedAt: "desc" },
        include: repoCardInclude,
      });
      return { repos: repos.map((r) => repoResponse(r)) };
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
        where: { ownerId, name, orgId: null },
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
          include: repoCardInclude,
        });
        return repoResponse(repo);
      }

      const repo = await prisma.repo.update({
        where: { id: existing.id },
        data,
        include: repoCardInclude,
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
        where: { ownerId, name: currentName, orgId: null },
        include: repoCardInclude,
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
          include: repoCardInclude,
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
        where: { ownerId: request.user.sub, name, orgId: null },
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
        where: { ownerId: request.user.sub, name, orgId: null },
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
        where: { ownerId: request.user.sub, name, orgId: null },
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
        where: { ownerId, name, orgId: null },
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

  // Returns everyone assignable to issues — the repo creator plus direct
  // collaborators, and (for org repos, issue #114) org OWNERs and members of teams
  // granted the repo. Visible to any repo reader.
  app.get(
    "/repos/:handle/:name/members",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };
      const name = nameParam.toLowerCase();
      const viewerId = (request as { user?: { sub: string } }).user?.sub;

      const userSel = { select: { id: true, handle: true, displayName: true } } as const;
      const repo = await prisma.repo.findFirst({
        where: repoByOwningHandleWhere(handleParam, name),
        include: {
          owner: userSel,
          collaborators: { include: { user: userSel } },
          org: {
            select: {
              id: true,
              handle: true,
              memberships: { select: { userId: true, role: true, user: userSel } },
            },
          },
          teamAccess: {
            select: { role: true, team: { select: { memberships: { select: { userId: true, user: userSel } } } } },
          },
        },
      });
      if (!repo) return reply.status(404).send({ error: "Not found" });
      if (repo.visibility === "PRIVATE" && !canRead(repo, viewerId)) {
        return reply.status(404).send({ error: "Not found" });
      }

      type Member = { id: string; handle: string; displayName: string | null; role: "owner" | "writer" | "reader" };
      const byId = new Map<string, Member>();
      const add = (m: Member) => {
        // Highest role wins if a user appears via multiple grants (owner > writer > reader).
        const rank = { owner: 2, writer: 1, reader: 0 } as const;
        const prev = byId.get(m.id);
        if (!prev || rank[m.role] > rank[prev.role]) byId.set(m.id, m);
      };

      add({ id: repo.owner.id, handle: repo.owner.handle, displayName: repo.owner.displayName, role: "owner" });
      for (const c of repo.collaborators) {
        add({ id: c.user.id, handle: c.user.handle, displayName: c.user.displayName, role: c.role === "WRITER" ? "writer" : "reader" });
      }
      if (repo.org) {
        for (const m of repo.org.memberships) {
          if (m.role === "OWNER") add({ id: m.user.id, handle: m.user.handle, displayName: m.user.displayName, role: "owner" });
        }
        for (const access of repo.teamAccess) {
          for (const tm of access.team.memberships) {
            add({ id: tm.user.id, handle: tm.user.handle, displayName: tm.user.displayName, role: access.role === "WRITER" ? "writer" : "reader" });
          }
        }
      }
      return { members: [...byId.values()] };
    },
  );

  app.get(
    "/repos/:handle/:name/storage",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };
      const name = nameParam.toLowerCase();

      const repo = await prisma.repo.findFirst({
        where: repoByOwningHandleWhere(handleParam, name),
        include: { org: { select: { memberships: { select: { userId: true, role: true } } } } },
      });

      // Repo creator or an OWNER of the owning org may inspect storage.
      const isOrgOwner = repo?.org?.memberships.some((m) => m.userId === request.user.sub && m.role === "OWNER") ?? false;
      if (!repo || (repo.ownerId !== request.user.sub && !isOrgOwner)) {
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
