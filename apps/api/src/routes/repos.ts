import { sshClientConfig } from "../ssh/config.js";
import type { CollaboratorRole, Repo, RepoVisibility } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { bareRepoPathFromKey, buildStorageKey, createBareRepo, inspectBareRepo, moveBareRepo, removeBareRepo, removeEmptyOwnerDir } from "../git-storage.js";
import { seedFromTemplate } from "../repo-template.js";
import { resolveActorIdentity } from "../pull-merge.js";
import { runPostReceiveEffects } from "../git-push-shared.js";
import { detectRepoLicense } from "../license.js";
import { prisma } from "../prisma.js";
import { canAdmin, canRead, redirectedRepoId, repoAccessInclude, repoByOwningHandleWhere, resolveRepo, viewerPermission } from "../repo-access.js";
import { branchExists, setDefaultBranch } from "../git-utils.js";
import { repoMergePolicy } from "../merge-policy.js";
import { ensureImplicitWatch, pruneWatchOnAccessLoss } from "../watch-service.js";
import {
  addCollaboratorBodySchema,
  createRepoBodySchema,
  renameRepoBodySchema,
  transferRepoBodySchema,
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

/** The `code` of a Prisma (P2002) or filesystem (EEXIST) error, if it has one. */
function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
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
 * can offer an SSH tab. The port comes from server config (FORGEHUB_SSH_PUBLIC_PORT,
 * else FORGEHUB_SSH_PORT — see ssh/config.ts);
 * null means the SSH transport is disabled and the web hides the SSH option.
 * `sshHost` is an optional explicit override (FORGEHUB_SSH_HOST) — when null the
 * web falls back to the browser's current hostname.
 */
function sshCloneConfig(): { sshPort: number | null; sshHost: string | null } {
  const { sshPort, sshHost } = sshClientConfig();
  return { sshPort, sshHost };
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
    // Merge policy columns (issue #119); absent on narrower selects ⇒ defaults.
    allowedMergeMethods?: string | null;
    defaultMergeMethod?: string | null;
    // Repository settings (#256); absent on narrower selects ⇒ off.
    archivedAt?: Date | null;
    deleteBranchOnMerge?: boolean;
    hasIssues?: boolean;
    hasProjects?: boolean;
    allowAutoMerge?: boolean;
    autoCloseIssues?: boolean;
    mergeCommitMessage?: string;
    squashCommitMessage?: string;
    isTemplate?: boolean;
    suggestUpdateBranch?: boolean;
    // Grouped star count (issue #88) — populated when the query includes
    // `_count.stars` (repoCardInclude does); 0 when the include was omitted.
    _count?: { stars: number };
  },
  lineage?: ForkLineage,
) {
  // Owning handle: the org's when org-owned, otherwise the creating user's.
  const ownerHandle = r.org?.handle ?? r.owner?.handle;
  const mergePolicy = repoMergePolicy(r);
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
    // Star count (issue #88): a grouped count, no denormalized column.
    starCount: r._count?.stars ?? 0,
    // Fork lineage — populated only on the repo detail payload (issue #113).
    parent: lineage?.parent ?? null,
    source: lineage?.source ?? null,
    forkCount: lineage?.forkCount ?? 0,
    // Owner merge policy (issue #119): drives the merge box's method menu.
    allowedMergeMethods: mergePolicy.allowedMethods,
    defaultMergeMethod: mergePolicy.defaultMethod,
    // Repository settings (#256).
    archived: !!r.archivedAt,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    deleteBranchOnMerge: r.deleteBranchOnMerge ?? false,
    hasIssues: r.hasIssues ?? true,
    hasProjects: r.hasProjects ?? true,
    allowAutoMerge: r.allowAutoMerge ?? true,
    autoCloseIssues: r.autoCloseIssues ?? true,
    mergeCommitMessage: r.mergeCommitMessage ?? "default",
    squashCommitMessage: r.squashCommitMessage ?? "default",
    isTemplate: r.isTemplate ?? false,
    suggestUpdateBranch: r.suggestUpdateBranch ?? false,

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
  // Grouped star count for the card/detail payloads (issue #88).
  _count: { select: { stars: true } },
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
  const adminScope = app.requireScope("admin");

  /**
   * The repo at `:handle/:name` if the caller may administer it (#217): 404 when
   * they can't even read it, 403 when they can read but not administer. Null —
   * with the response already sent — otherwise.
   */
  async function adminRepo(request: FastifyRequest, reply: FastifyReply) {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) {
      reply.status(404).send({ error: "Repository not found" });
      return null;
    }
    if (!canAdmin(repo, userId)) {
      reply.status(403).send({ error: "Only the repository's admins can change its settings" });
      return null;
    }
    return repo;
  }

  /** Description, visibility and merge policy — shared by the legacy and owner-scoped routes. */
  async function applySettings(
    existing: Repo,
    body: z.infer<typeof updateRepoBodySchema>,
    reply: FastifyReply,
  ) {
    const { description, visibility, allowedMergeMethods, defaultMergeMethod, defaultBranch, archived, deleteBranchOnMerge, ...flags } = body;
    const descriptionValue =
      description === undefined ? undefined : description === null ? null : description.trim() || null;

    const data: {
      description?: string | null;
      visibility?: RepoVisibility;
      allowedMergeMethods?: string;
      defaultMergeMethod?: string;
      archivedAt?: Date | null;
      deleteBranchOnMerge?: boolean;
      hasIssues?: boolean;
      hasProjects?: boolean;
      allowAutoMerge?: boolean;
      autoCloseIssues?: boolean;
      mergeCommitMessage?: string;
      squashCommitMessage?: string;
      isTemplate?: boolean;
      suggestUpdateBranch?: boolean;
    } = {};
    // More settings (#256): features, pull request behaviour, merge messages.
    for (const [k, v] of Object.entries(flags)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;

    // An archived repository's settings stay read-only too, apart from unarchiving it.
    if (existing.archivedAt && archived !== false) {
      const other = Object.entries(body).some(([k, v]) => k !== "archived" && v !== undefined);
      if (other) return reply.status(409).send({ error: "This repository is archived. Unarchive it to change its settings." });
    }
    if (archived !== undefined) data.archivedAt = archived ? (existing.archivedAt ?? new Date()) : null;
    if (deleteBranchOnMerge !== undefined) data.deleteBranchOnMerge = deleteBranchOnMerge;
    // Default branch (#256): HEAD in the bare repository, not a column.
    if (defaultBranch !== undefined) {
      if (!existing.storageKey || !(await branchExists(existing.storageKey, defaultBranch))) {
        return reply.status(400).send({ error: `Branch '${defaultBranch}' not found` });
      }
      await setDefaultBranch(existing.storageKey, defaultBranch);
    }
    if (descriptionValue !== undefined) {
      data.description = descriptionValue;
    }
    if (visibility !== undefined) {
      data.visibility = fromApiVisibility(visibility);
    }

    // Merge policy (issue #119): cross-field rule — the effective default must
    // stay inside the effective allowed set, whichever of the two arrived.
    if (allowedMergeMethods !== undefined || defaultMergeMethod !== undefined) {
      const current = repoMergePolicy(existing);
      const nextAllowed = allowedMergeMethods ?? current.allowedMethods;
      const nextDefault = defaultMergeMethod ?? current.defaultMethod;
      if (!nextAllowed.includes(nextDefault)) {
        return reply.status(400).send({
          error: `defaultMergeMethod '${nextDefault}' must be one of the allowed methods (${nextAllowed.join(", ")})`,
        });
      }
      if (allowedMergeMethods !== undefined) data.allowedMergeMethods = [...new Set(nextAllowed)].join(",");
      if (defaultMergeMethod !== undefined) data.defaultMergeMethod = nextDefault;
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
  }

  /** A repo's direct collaborators, oldest first — shared by the legacy and owner-scoped routes. */
  async function listCollaborators(repoId: string) {
    const collaborators = await prisma.repoCollaborator.findMany({
      where: { repoId },
      include: { user: { select: { id: true, handle: true, email: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      collaborators: collaborators.map((c) => ({
        id: c.id,
        role: fromDbCollaboratorRole(c.role),
        createdAt: c.createdAt.toISOString(),
        user: c.user,
      })),
    };
  }

  /** Grant (or change) a collaborator's role. */
  async function addCollaborator(
    repo: Repo,
    body: z.infer<typeof addCollaboratorBodySchema>,
    reply: FastifyReply,
  ) {
    const collaboratorUser = await prisma.user.findUnique({
      where: { handle: body.handle.toLowerCase() },
    });
    if (!collaboratorUser) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (collaboratorUser.id === repo.ownerId) {
      return reply.status(400).send({ error: "Owner is already implicitly a collaborator" });
    }

    const role = toDbCollaboratorRole(body.role);
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

    // New collaborators implicitly watch the repo at ALL (issue #88); an
    // explicit level they already chose is preserved.
    await ensureImplicitWatch(repo.id, collaboratorUser.id);

    return reply.status(201).send({
      id: collaborator.id,
      role: fromDbCollaboratorRole(collaborator.role),
      createdAt: collaborator.createdAt.toISOString(),
      user: collaborator.user,
    });
  }

  /** Revoke a collaborator by handle. */
  async function removeCollaborator(repo: Repo, handle: string, reply: FastifyReply) {
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

    // The implicit ALL watch must not outlive the grant that created it: drop
    // it when the removal actually costs them read access (issue #88).
    await pruneWatchOnAccessLoss(repo.id, user.id);

    return reply.status(204).send();
  }
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

      // Starting from a template (#256): one the caller can read and that is marked as a template.
      let templateKey: string | null = null;
      if (parsed.data.template) {
        const [th, tn] = parsed.data.template.split("/");
        const template = await resolveRepo(th, tn);
        if (!template || !canRead(template, ownerId) || !template.isTemplate || !template.storageKey) {
          return reply.status(404).send({ error: "Template repository not found" });
        }
        templateKey = template.storageKey;
      }

      const storageKey = buildStorageKey(namespaceHandle, name);
      const nameTaken = orgId
        ? "This organization already has a repository with this name"
        : "You already have a repository with this name";

      // Never touch storage that existed before this request. The row check is
      // the common case; createBareRepo refusing an existing path covers a race
      // with a concurrent create and storage left behind without a row.
      const existing = await prisma.repo.findUnique({ where: { storageKey }, select: { id: true } });
      if (existing) {
        return reply.status(409).send({ error: nameTaken });
      }
      try {
        await createBareRepo(storageKey);
      } catch (e: unknown) {
        if (errorCode(e) === "EEXIST") {
          return reply.status(409).send({ error: nameTaken });
        }
        throw e;
      }

      let repo;
      try {
        repo = await prisma.repo.create({
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
      } catch (e: unknown) {
        // The directory is the one createBareRepo just made for this request.
        await removeBareRepo(storageKey);
        if (errorCode(e) === "P2002") {
          return reply.status(409).send({ error: nameTaken });
        }
        throw e;
      }
      // The creator implicitly watches their new repo at ALL (issue #88).
      await ensureImplicitWatch(repo.id, ownerId);
      if (templateKey) {
        try {
          await seedFromTemplate(storageKey, templateKey, await resolveActorIdentity(ownerId));
          // The first commit counts like a push: ingestion, feed, CI.
          await runPostReceiveEffects(app, { id: repo.id, storageKey }, ownerId, bareRepoPathFromKey(storageKey), new Map());
        } catch (err) {
          request.log.error({ err }, "starting a repository from its template failed");
        }
      }
      return reply.status(201).send(repoResponse(repo));
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
      const include = {
        ...repoAccessInclude,
        owner: { select: { handle: true } },
        ...topicsInclude,
        _count: { select: { stars: true } },
      } as const;
      // A name the repository used to have (#256) still finds it; the answer's
      // ownerHandle/name are the current ones, which the web moves to.
      let repo = await prisma.repo.findFirst({ where: repoByOwningHandleWhere(handleParam, name), include });
      if (!repo) {
        const redirectId = await redirectedRepoId(handleParam, name);
        if (redirectId) repo = await prisma.repo.findFirst({ where: { id: redirectId }, include });
      }
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
      // What the viewer may do here (#217): the web app gates Settings and the
      // other owner controls on this, never on comparing handles.
      return { ...repoResponse(repo, lineage), license, viewerPermission: viewerPermission(repo, viewer) };
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
      return applySettings(existing, parsed.data, reply);
    },
  );

  // PATCH /repos/:handle/:name/settings — the owner-scoped settings update
  // (#217). The legacy route above can only find the caller's own personal repo;
  // this one addresses the repo by its owning handle, so an org repo's admins can
  // reach it and it can never fall through to a same-named repo of the caller's.
  // Not PATCH /repos/:handle/:name: that shape is the legacy /repos/:name/rename.
  app.patch(
    "/repos/:handle/:name/settings",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const parsed = updateRepoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      return applySettings(repo, parsed.data, reply);
    },
  );

  // POST /repos/:handle/:name/rename { name } — rename (#256): any repo the
  // caller administers, personal or org. The bare repository moves with it, and
  // the old name keeps redirecting (web and git) until another repo takes it.
  app.post(
    "/repos/:handle/:name/rename",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const parsed = renameRepoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      if (repo.archivedAt) {
        return reply.status(409).send({ error: "This repository is archived. Unarchive it to rename it." });
      }

      const newName = parsed.data.name.toLowerCase();
      if (newName === repo.name) return reply.send({ name: repo.name });
      const owner = await prisma.user.findUnique({ where: { id: repo.ownerId }, select: { handle: true } });
      const owningHandle = (repo.org?.handle ?? owner?.handle ?? "").toLowerCase();
      if (!owningHandle) return reply.status(500).send({ error: "Owner handle missing" });

      const taken = await prisma.repo.findFirst({ where: repoByOwningHandleWhere(owningHandle, newName), select: { id: true } });
      if (taken) return reply.status(409).send({ error: `${owningHandle}/${newName} already exists` });

      const newStorageKey = repo.storageKey ? buildStorageKey(owningHandle, newName) : null;
      let moved = false;
      try {
        if (repo.storageKey && newStorageKey) {
          await moveBareRepo(repo.storageKey, newStorageKey);
          moved = true;
        }
        await prisma.$transaction([
          prisma.repo.update({ where: { id: repo.id }, data: { name: newName, storageKey: newStorageKey } }),
          // The new name is no longer anyone's redirect; the old one now is this repo's.
          prisma.repoRedirect.deleteMany({ where: { ownerHandle: owningHandle, name: { in: [newName, repo.name] } } }),
          prisma.repoRedirect.create({ data: { ownerHandle: owningHandle, name: repo.name, repoId: repo.id } }),
        ]);
      } catch (e: unknown) {
        if (moved && repo.storageKey && newStorageKey) {
          await moveBareRepo(newStorageKey, repo.storageKey).catch(() => undefined);
        }
        const code = errorCode(e);
        if (code === "P2002" || code === "EEXIST") {
          return reply.status(409).send({ error: `${owningHandle}/${newName} already exists` });
        }
        throw e;
      }
      return reply.send({ name: newName, fullName: `${owningHandle}/${newName}` });
    },
  );

  // POST /repos/:handle/:name/transfer { newOwner } — transfer ownership (#256)
  // to an organization the caller owns, or to the caller's own account. Moving
  // it to another person would need them to accept, which ForgeHub doesn't do
  // yet. The old address keeps redirecting, like a rename.
  app.post(
    "/repos/:handle/:name/transfer",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const parsed = transferRepoBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      if (repo.archivedAt) return reply.status(409).send({ error: "This repository is archived. Unarchive it to transfer it." });

      const userId = request.user.sub;
      const target = parsed.data.newOwner.toLowerCase();
      const owner = await prisma.user.findUnique({ where: { id: repo.ownerId }, select: { handle: true } });
      const currentHandle = (repo.org?.handle ?? owner?.handle ?? "").toLowerCase();
      if (target === currentHandle) return reply.status(400).send({ error: `${target} already owns this repository` });

      const [org, me, person] = await Promise.all([
        prisma.organization.findUnique({
          where: { handle: target },
          select: { id: true, memberships: { where: { userId, role: "OWNER" }, select: { userId: true } } },
        }),
        prisma.user.findUnique({ where: { id: userId }, select: { handle: true } }),
        prisma.user.findUnique({ where: { handle: target }, select: { id: true } }),
      ]);
      let next: { orgId: string | null; ownerId: string };
      if (org) {
        if (org.memberships.length === 0) return reply.status(403).send({ error: "You can only transfer repositories to organizations you own" });
        next = { orgId: org.id, ownerId: repo.ownerId };
      } else if (me?.handle === target) {
        next = { orgId: null, ownerId: userId };
      } else if (person) {
        return reply.status(400).send({
          error: "Transferring to another person needs them to accept it, which ForgeHub doesn't support yet. Transfer it to an organization you both own instead.",
        });
      } else {
        return reply.status(404).send({ error: `No user or organization is called ${target}` });
      }

      const taken = await prisma.repo.findFirst({ where: repoByOwningHandleWhere(target, repo.name), select: { id: true } });
      if (taken) return reply.status(409).send({ error: `${target}/${repo.name} already exists` });

      const newStorageKey = repo.storageKey ? buildStorageKey(target, repo.name) : null;
      let moved = false;
      try {
        if (repo.storageKey && newStorageKey) {
          await moveBareRepo(repo.storageKey, newStorageKey);
          moved = true;
        }
        await prisma.$transaction([
          prisma.repo.update({ where: { id: repo.id }, data: { ...next, storageKey: newStorageKey } }),
          prisma.repoRedirect.deleteMany({ where: { ownerHandle: target, name: repo.name } }),
          prisma.repoRedirect.upsert({
            where: { ownerHandle_name: { ownerHandle: currentHandle, name: repo.name } },
            create: { ownerHandle: currentHandle, name: repo.name, repoId: repo.id },
            update: { repoId: repo.id },
          }),
        ]);
      } catch (e: unknown) {
        if (moved && repo.storageKey && newStorageKey) await moveBareRepo(newStorageKey, repo.storageKey).catch(() => undefined);
        const code = errorCode(e);
        if (code === "P2002" || code === "EEXIST") return reply.status(409).send({ error: `${target}/${repo.name} already exists` });
        throw e;
      }
      if (moved && repo.storageKey) await removeEmptyOwnerDir(repo.storageKey);
      return reply.send({ fullName: `${target}/${repo.name}` });
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
        // EEXIST: moveBareRepo found the target directory taken and moved nothing.
        const code = errorCode(e);
        if (code === "P2002" || code === "EEXIST") {
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
      });
      if (!repo) {
        return reply.status(404).send({ error: "Repository not found" });
      }
      return listCollaborators(repo.id);
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
      return addCollaborator(repo, parsed.data, reply);
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
      return removeCollaborator(repo, handle, reply);
    },
  );

  // Owner-scoped collaborator management (#217): what the Settings page uses, so
  // an org repo's admins can manage its collaborators. The legacy routes above
  // only ever find the caller's own personal repo.
  app.get(
    "/repos/:handle/:name/collaborators",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      return listCollaborators(repo.id);
    },
  );

  app.post(
    "/repos/:handle/:name/collaborators",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const parsed = addCollaboratorBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      return addCollaborator(repo, parsed.data, reply);
    },
  );

  app.delete(
    "/repos/:handle/:name/collaborators/:collaborator",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      const { collaborator } = request.params as { collaborator: string };
      return removeCollaborator(repo, collaborator.toLowerCase(), reply);
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

  // Owner-qualified delete, addressed like GET /repos/:handle/:name. The bare-name
  // route above resolves against the CALLER's namespace, so a client on someone
  // else's repo page sending just the name would silently delete its own same-named
  // repo instead; here the owning handle is part of the address and a repo the
  // caller does not own is a 404, never a deletion.
  app.delete(
    "/repos/:handle/:name",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle: handleParam, name: nameParam } = request.params as { handle: string; name: string };

      // Deletion is owner-only: the creator for a personal repo, an OWNER of the
      // owning org for an org repo. Anyone else — including org members and team
      // writers — gets the same 404 as a missing repo, so nothing leaks.
      const found = await prisma.repo.findFirst({
        where: repoByOwningHandleWhere(handleParam, nameParam),
        include: { org: { select: { memberships: { select: { userId: true, role: true } } } } },
      });
      const existing = found && canAdmin(found, request.user.sub) ? found : null;
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
