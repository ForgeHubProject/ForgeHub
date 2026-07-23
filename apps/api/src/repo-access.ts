import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Prisma include fragment shared by every path that runs a read/write access
 * check (issue #114). It pulls the three grant sources `canRead`/`canWrite`
 * inspect:
 *   - `collaborators`  — direct per-repo grants (pre-existing).
 *   - `org`            — the owning org's memberships, so an org OWNER is resolved.
 *   - `teamAccess`     — teams granted this repo, each with its member set, so a
 *                        team READER/WRITER is resolved.
 * Keeping it in one place means git-http and the JSON routes evaluate access over
 * an identical shape.
 */
export const repoAccessInclude = {
  collaborators: { select: { userId: true, role: true } },
  org: {
    select: {
      id: true,
      handle: true,
      memberships: { select: { userId: true, role: true } },
    },
  },
  teamAccess: {
    select: {
      role: true,
      team: { select: { memberships: { select: { userId: true } } } },
    },
  },
} as const;

/**
 * A `where` matching a repo by its OWNING handle (issue #114) in a SINGLE query:
 * either a personal repo under a user handle (`orgId: null`) OR an org repo under
 * an org handle. Because handles are unique across the two namespaces, at most one
 * branch matches — no separate owner lookup is needed, so any code that mocks
 * `repo.findFirst` keeps resolving repos exactly as before.
 */
export function repoByOwningHandleWhere(handle: string, name: string): Prisma.RepoWhereInput {
  const h = handle.toLowerCase();
  return {
    name: name.toLowerCase(),
    OR: [
      { owner: { handle: h }, orgId: null },
      { org: { handle: h } },
    ],
  };
}

/**
 * Resolve a repo by its OWNING handle (`:handle/:name`) — the handle may name a
 * user (personal repo) or an org (org-owned repo). Returns null when no such repo
 * exists. The payload carries everything `canRead`/`canWrite` need.
 */
export async function resolveRepo(handle: string, name: string) {
  return prisma.repo.findFirst({
    where: repoByOwningHandleWhere(handle, name),
    include: repoAccessInclude,
  });
}

/**
 * The access-relevant slice of a repo. `canRead`/`canWrite` accept anything that
 * structurally provides these fields — the full `resolveRepo` payload satisfies
 * it, as do the git-http lookups and test fixtures. `org`/`teamAccess` are
 * optional so a caller that fetches a leaner shape (or a mock) still type-checks;
 * an absent relation is treated as "no grant from that source".
 */
export type RepoAccessInput = {
  visibility: "PUBLIC" | "PRIVATE";
  ownerId: string;
  collaborators: Array<{ userId: string; role: "READER" | "WRITER" }>;
  orgId?: string | null;
  org?: { memberships: Array<{ userId: string; role: string }> } | null;
  teamAccess?: Array<{ role: string; team: { memberships: Array<{ userId: string }> } }>;
};

/** Is `userId` an OWNER of the repo's owning org? */
function isOrgOwner(repo: RepoAccessInput, userId: string): boolean {
  return (repo.org?.memberships ?? []).some((m) => m.userId === userId && m.role === "OWNER");
}

/** Highest team role `userId` holds on this repo, or null if none. */
function teamRoleFor(repo: RepoAccessInput, userId: string): "READER" | "WRITER" | null {
  let role: "READER" | "WRITER" | null = null;
  for (const access of repo.teamAccess ?? []) {
    if (!access.team.memberships.some((m) => m.userId === userId)) continue;
    if (access.role === "WRITER") return "WRITER";
    role = "READER";
  }
  return role;
}

/**
 * Read access. Precedence (any grant suffices):
 *   PUBLIC repo → everyone · repo creator · direct collaborator · org OWNER ·
 *   member of a team granted the repo (READER or WRITER).
 * A PRIVATE org repo is therefore readable only by org members who actually have
 * access — a bare org MEMBER with no team grant gets nothing.
 */
export function canRead(repo: RepoAccessInput, userId: string | undefined): boolean {
  if (repo.visibility === "PUBLIC") return true;
  if (!userId) return false;
  if (repo.ownerId === userId) return true;
  if (repo.collaborators.some((c) => c.userId === userId)) return true;
  if (isOrgOwner(repo, userId)) return true;
  if (teamRoleFor(repo, userId) !== null) return true;
  return false;
}

/**
 * Write access. Precedence (any grant suffices):
 *   repo creator · direct WRITER collaborator · org OWNER · member of a team
 *   granted the repo at WRITER.
 */
export function canWrite(repo: RepoAccessInput, userId: string | undefined): boolean {
  if (!userId) return false;
  if (repo.ownerId === userId) return true;
  if (repo.collaborators.some((c) => c.userId === userId && c.role === "WRITER")) return true;
  if (isOrgOwner(repo, userId)) return true;
  if (teamRoleFor(repo, userId) === "WRITER") return true;
  return false;
}
