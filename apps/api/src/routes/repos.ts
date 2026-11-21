import { sshClientConfig } from "../ssh/config.js";
import type { CollaboratorRole, Prisma, Repo, RepoVisibility } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  bareRepoPathFromKey, buildStorageKey, createBareRepo, inspectBareRepo, moveBareRepo, removeBareRepo, removeAttachments, removeEmptyOwnerDir, removeSocialPreview,
} from "../git-storage.js";
import { seedFromTemplate } from "../repo-template.js";
import { fetchGithubRepo, ImportError, parseGithubRepo, runGithubImport, type GithubRepo } from "../github-import.js";
import { startIssueImport, startIssueImportIfAsked } from "../github-issue-import.js";
import { fillMissingFormats, parseFormats } from "../repo-formats.js";
import { resolveActorIdentity } from "../pull-merge.js";
import { runPostReceiveEffects } from "../git-push-shared.js";
import { detectRepoLicense } from "../license.js";
import { prisma } from "../prisma.js";
import { isBlocked } from "../blocks.js";
import { sendRepoTransferEmail } from "../repo-transfer-mail.js";
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

/** Moving or deleting the directory a GitHub import is fetching into would corrupt or orphan it (#289). */
const STILL_IMPORTING = "This repository is still importing. Try again when it's done.";

/** A person has a day to accept a repository transferred to them, as on GitHub (#256). */
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

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
    socialPreviewKey?: string | null;
    // GitHub import (#289); absent on narrower selects ⇒ not imported.
    importSource?: string | null;
    importStatus?: string | null;
    importError?: string | null;
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
    // Social preview (#256): changes with each upload, so it versions the image's URL.
    socialPreviewKey: r.socialPreviewKey ?? null,
    // GitHub import (#289): "importing" or "failed" while the page shows its progress.
    importSource: r.importSource ?? null,
    importStatus: r.importStatus ?? null,
    importError: r.importError ?? null,

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

      // Importing from GitHub (#289): refused here, before anything is created or downloaded.
      const from = parsed.data.importFrom ? parseGithubRepo(parsed.data.importFrom) : null;
      if (parsed.data.importFrom) {
        if (parsed.data.template) {
          return reply.status(400).send({ error: "Start from a template or import a repository, not both" });
        }
        if (!from) {
          return reply.status(400).send({ error: "Enter a GitHub repository as https://github.com/owner/name or owner/name" });
        }
        if (await prisma.repo.count({ where: { ownerId, importStatus: "importing" } })) {
          return reply.status(429).send({ error: "Wait for your other import to finish first" });
        }
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
      // Asked last: the server's GitHub requests are counted, 60 an hour or 5,000 with FORGEHUB_GITHUB_TOKEN (#289).
      let source: GithubRepo | null = null;
      if (from) {
        try {
          source = await fetchGithubRepo(from.owner, from.name);
        } catch (e) {
          if (e instanceof ImportError) return reply.status(e.status).send({ error: e.message });
          throw e;
        }
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
            description: parsed.data.description?.trim() || source?.description || null,
            // An import is public like its source, with its topics (#289).
            visibility: source ? "PUBLIC" : fromApiVisibility(parsed.data.visibility),
            storageKey,
            ownerId,
            orgId,
            ...(source && {
              importSource: `${source.owner}/${source.name}`,
              importStatus: "importing",
              topics: { create: source.topics.map((topic) => ({ topic })) },
              // Waits for the git history, then starts (#289, phase 2).
              ...(parsed.data.importIssues && { issueImport: { create: {} } }),
            }),
          },
          include: { owner: { select: { handle: true } }, org: { select: { handle: true } }, ...topicsInclude },
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
      if (source) {
        const repoId = repo.id;
        void runGithubImport(app, { id: repoId, storageKey }, ownerId, source).then(() => startIssueImportIfAsked(app, repoId));
      }
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
      // The Repositories tab's format filter (#257): what each one holds.
      const unscanned = repos.filter((r) => r.formats === null).map((r) => r.id);
      if (unscanned.length) await fillMissingFormats({ id: { in: unscanned } }).catch(() => undefined);
      const scanned = unscanned.length
        ? new Map((await prisma.repo.findMany({ where: { id: { in: unscanned } }, select: { id: true, formats: true } })).map((r) => [r.id, r.formats]))
        : new Map<string, string | null>();
      return { repos: repos.map((r) => ({ ...repoResponse(r), formats: parseFormats(scanned.get(r.id) ?? r.formats) })) };
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

  // POST /repos/:handle/:name/import/retry — run a failed GitHub import again (#289),
  // checking its source again first (it may have gone private or grown).
  app.post(
    "/repos/:handle/:name/import/retry",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      const from = repo.importSource ? parseGithubRepo(repo.importSource) : null;
      if (repo.importStatus !== "failed" || !from || !repo.storageKey) {
        return reply.status(409).send({ error: "This repository has no failed import to retry" });
      }
      const userId = request.user.sub;
      if (await prisma.repo.count({ where: { ownerId: userId, importStatus: "importing" } })) {
        return reply.status(429).send({ error: "Wait for your other import to finish first" });
      }
      let source: GithubRepo;
      try {
        source = await fetchGithubRepo(from.owner, from.name);
      } catch (e) {
        if (e instanceof ImportError) return reply.status(e.status).send({ error: e.message });
        throw e;
      }
      // Conditional, so two retries at once start one job.
      const { count } = await prisma.repo.updateMany({
        where: { id: repo.id, importStatus: "failed" },
        data: { importStatus: "importing", importError: null },
      });
      if (count === 0) return reply.status(409).send({ error: "This repository has no failed import to retry" });
      void runGithubImport(app, { id: repo.id, storageKey: repo.storageKey }, userId, source).then(() => startIssueImportIfAsked(app, repo.id));
      return reply.status(202).send({ importStatus: "importing" });
    },
  );

  // GET /repos/:handle/:name/import/issues — how far bringing the issues over from GitHub has got (#289, phase 2).
  app.get("/repos/:handle/:name/import/issues", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
    const job = await prisma.githubIssueImport.findUnique({ where: { repoId: repo.id } });
    return reply.send({
      import: job && {
        source: repo.importSource,
        stage: job.stage,
        issues: job.issues,
        comments: job.comments,
        releases: job.releases,
        waitUntil: job.waitUntil && job.waitUntil > new Date() ? job.waitUntil.toISOString() : null,
        error: job.error,
      },
    });
  });

  // POST /repos/:handle/:name/import/issues/retry — carry on after it stopped.
  app.post("/repos/:handle/:name/import/issues/retry", { preHandler: [app.authenticate, adminScope] }, async (request, reply) => {
    const repo = await adminRepo(request, reply);
    if (!repo) return reply;
    const { count } = await prisma.githubIssueImport.updateMany({ where: { repoId: repo.id, error: { not: null } }, data: { error: null } });
    if (count === 0) return reply.status(409).send({ error: "This repository has no stopped issue import to retry" });
    startIssueImport(app, repo.id);
    return reply.status(202).send({ stage: "importing" });
  });

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
      if (repo.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });

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

  /**
   * Moves a repository into `target`'s namespace (#256): the bare repository, its
   * owner, and a redirect from the old address, like a rename. Answers a name
   * clash itself (409) and returns false; `alsoRun` joins the same transaction.
   */
  async function moveRepoTo(
    repo: { id: string; name: string; storageKey: string | null },
    currentHandle: string,
    target: string,
    next: { orgId: string | null; ownerId: string },
    reply: FastifyReply,
    alsoRun: Prisma.PrismaPromise<unknown>[] = [],
  ): Promise<boolean> {
    const clash = () => reply.status(409).send({ error: `${target}/${repo.name} already exists` });
    const taken = await prisma.repo.findFirst({ where: repoByOwningHandleWhere(target, repo.name), select: { id: true } });
    if (taken) {
      clash();
      return false;
    }
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
        // A transfer still waiting for someone is settled by this move.
        prisma.repoTransfer.deleteMany({ where: { repoId: repo.id } }),
        ...alsoRun,
      ]);
    } catch (e: unknown) {
      if (moved && repo.storageKey && newStorageKey) await moveBareRepo(newStorageKey, repo.storageKey).catch(() => undefined);
      const code = errorCode(e);
      if (code === "P2002" || code === "EEXIST") {
        clash();
        return false;
      }
      throw e;
    }
    if (moved && repo.storageKey) await removeEmptyOwnerDir(repo.storageKey);
    return true;
  }

  // POST /repos/:handle/:name/transfer { newOwner } — transfer ownership (#256).
  // To an organization the caller owns, or to the caller's own account: at once.
  // To another person: a request they have a day to accept, as on GitHub; the
  // repository stays where it is until then. The old address keeps redirecting.
  app.post(
    "/repos/:handle/:name/transfer",
    { preHandler: [app.authenticate, adminScope] },
    async (request, reply) => {
      const parsed = transferRepoBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      const repo = await adminRepo(request, reply);
      if (!repo) return reply;
      if (repo.archivedAt) return reply.status(409).send({ error: "This repository is archived. Unarchive it to transfer it." });
      if (repo.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });

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
        prisma.user.findUnique({ where: { handle: target }, select: { id: true, email: true } }),
      ]);
      let next: { orgId: string | null; ownerId: string };
      if (org) {
        if (org.memberships.length === 0) return reply.status(403).send({ error: "You can only transfer repositories to organizations you own" });
        next = { orgId: org.id, ownerId: repo.ownerId };
      } else if (me?.handle === target) {
        next = { orgId: null, ownerId: userId };
      } else if (person && me) {
        if (await isBlocked(person.id, userId)) return reply.status(403).send({ error: `You can't transfer repositories to ${target}` });
        const taken = await prisma.repo.findFirst({ where: repoByOwningHandleWhere(target, repo.name), select: { id: true } });
        if (taken) return reply.status(409).send({ error: `${target} already has a repository called ${repo.name}` });
        const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS);
        const request_ = { fromUserId: userId, toUserId: person.id, fromHandle: currentHandle, expiresAt };
        // A new request replaces one still waiting, to the same person or another.
        await prisma.repoTransfer.upsert({ where: { repoId: repo.id }, create: { repoId: repo.id, ...request_ }, update: { ...request_, createdAt: new Date() } });
        void sendRepoTransferEmail({ to: person.email, fromHandle: me.handle, repoFullName: `${currentHandle}/${repo.name}`, expiresAt });
        return reply.status(202).send({ pending: { to: target, expiresAt: expiresAt.toISOString() } });
      } else {
        return reply.status(404).send({ error: `No user or organization is called ${target}` });
      }

      if (!(await moveRepoTo(repo, currentHandle, target, next, reply))) return reply;
      return reply.send({ fullName: `${target}/${repo.name}` });
    },
  );

  // GET /repos/:handle/:name/transfer — the transfer waiting for someone to accept, for the settings page.
  app.get("/repos/:handle/:name/transfer", { preHandler: [app.authenticate] }, async (request, reply) => {
    const repo = await adminRepo(request, reply);
    if (!repo) return reply;
    const t = await prisma.repoTransfer.findUnique({ where: { repoId: repo.id }, select: { expiresAt: true, toUser: { select: { handle: true } } } });
    const live = t && t.expiresAt > new Date();
    return reply.send({ pending: live ? { to: t.toUser.handle, expiresAt: t.expiresAt.toISOString() } : null });
  });

  // DELETE /repos/:handle/:name/transfer — cancel it.
  app.delete("/repos/:handle/:name/transfer", { preHandler: [app.authenticate, adminScope] }, async (request, reply) => {
    const repo = await adminRepo(request, reply);
    if (!repo) return reply;
    await prisma.repoTransfer.deleteMany({ where: { repoId: repo.id } });
    return reply.status(204).send();
  });

  // GET /user/repo-transfers — repositories people want to transfer to you, still within their day.
  app.get("/user/repo-transfers", { preHandler: [app.authenticate] }, async (request) => {
    const rows = await prisma.repoTransfer.findMany({
      where: { toUserId: request.user.sub, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, expiresAt: true, fromHandle: true,
        fromUser: { select: { handle: true } },
        repo: { select: { name: true, visibility: true, description: true } },
      },
    });
    return {
      transfers: rows.map((t) => ({
        id: t.id,
        repoFullName: `${t.fromHandle}/${t.repo.name}`,
        visibility: t.repo.visibility.toLowerCase(),
        description: t.repo.description,
        from: t.fromUser.handle,
        expiresAt: t.expiresAt.toISOString(),
      })),
    };
  });

  /** The caller's own transfer request by id; answers 404 / 410 itself and returns null. */
  async function incomingTransfer(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const t = await prisma.repoTransfer.findUnique({
      where: { id },
      select: {
        id: true, toUserId: true, fromHandle: true, expiresAt: true,
        repo: { select: { id: true, name: true, storageKey: true, archivedAt: true, importStatus: true, owner: { select: { handle: true } }, org: { select: { handle: true } } } },
      },
    });
    if (!t || t.toUserId !== request.user.sub) {
      reply.status(404).send({ error: "No such transfer request" });
      return null;
    }
    if (t.expiresAt <= new Date()) {
      await prisma.repoTransfer.deleteMany({ where: { id: t.id } });
      reply.status(410).send({ error: "This transfer request has expired. Ask for a new one." });
      return null;
    }
    return t;
  }

  // POST /user/repo-transfers/:id/accept — the repository becomes yours.
  app.post("/user/repo-transfers/:id/accept", { preHandler: [app.authenticate, adminScope] }, async (request, reply) => {
    const t = await incomingTransfer(request, reply);
    if (!t) return reply;
    const currentHandle = (t.repo.org?.handle ?? t.repo.owner.handle).toLowerCase();
    if (currentHandle !== t.fromHandle) {
      await prisma.repoTransfer.deleteMany({ where: { id: t.id } });
      return reply.status(409).send({ error: "This repository has moved since the request. Ask for a new one." });
    }
    if (t.repo.archivedAt) return reply.status(409).send({ error: "This repository was archived after the request. Ask its owner to unarchive it." });
    if (t.repo.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });
    const userId = request.user.sub;
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true } });
    if (!me) return reply.status(401).send({ error: "Unauthorized" });
    // As the owner you no longer need a collaborator's seat on it.
    const ok = await moveRepoTo(t.repo, currentHandle, me.handle, { orgId: null, ownerId: userId }, reply, [
      prisma.repoCollaborator.deleteMany({ where: { repoId: t.repo.id, userId } }),
    ]);
    if (!ok) return reply;
    return reply.send({ fullName: `${me.handle}/${t.repo.name}` });
  });

  // POST /user/repo-transfers/:id/decline — it stays where it is.
  app.post("/user/repo-transfers/:id/decline", { preHandler: [app.authenticate] }, async (request, reply) => {
    const t = await incomingTransfer(request, reply);
    if (!t) return reply;
    await prisma.repoTransfer.deleteMany({ where: { id: t.id } });
    return reply.status(204).send();
  });

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
      if (existing.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });

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
      if (existing.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });

      await prisma.repo.delete({ where: { id: existing.id } });

      if (existing.storageKey) {
        await removeBareRepo(existing.storageKey);
      }
      if (existing.socialPreviewKey) await removeSocialPreview(existing.id).catch(() => {});
      await removeAttachments(existing.id).catch(() => {});

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
      if (existing.importStatus === "importing") return reply.status(409).send({ error: STILL_IMPORTING });

      await prisma.repo.delete({ where: { id: existing.id } });

      if (existing.storageKey) {
        await removeBareRepo(existing.storageKey);
      }
      if (existing.socialPreviewKey) await removeSocialPreview(existing.id).catch(() => {});
      await removeAttachments(existing.id).catch(() => {});

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
      // Teams to @mention (#253): the owning organization's, for its own members.
      const mentionableTeams =
        repo.org && viewerId && repo.org.memberships.some((m) => m.userId === viewerId)
          ? (await prisma.team.findMany({ where: { orgId: repo.org.id }, select: { slug: true, name: true }, orderBy: { slug: "asc" } }))
              .map((t) => ({ handle: `${repo.org!.handle}/${t.slug}`, name: t.name }))
          : [];
      return { members: [...byId.values()], teams: mentionableTeams };
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
