import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { isHandleTaken } from "../owner-resolve.js";
import { canRead, repoAccessInclude } from "../repo-access.js";
import { repoResponse } from "./repos.js";
import {
  addOrgMemberBodySchema,
  addTeamMemberBodySchema,
  createOrgBodySchema,
  createTeamBodySchema,
  grantTeamRepoBodySchema,
  updateOrgBodySchema,
  updateOrgMemberBodySchema,
  updateTeamBodySchema,
} from "../validation.js";

// ─── Organizations & teams (issue #114) ──────────────────────────────────────────
//
// Orgs are shared owning namespaces (see repo-access.ts / owner-resolve.ts). These
// routes cover: org CRUD + profile, membership management, team CRUD + team
// membership, and team→repo access grants. All mutating routes require an
// authenticated session/PAT plus a membership check (OWNER for management); reads
// are public for public data and gated for member-only data. Repo creation inside
// an org lives on POST /repos (an optional `owner` namespace).

const userSelect = { select: { id: true, handle: true, displayName: true } } as const;

type ViewerRole = "OWNER" | "MEMBER" | null;

function viewerId(request: FastifyRequest): string | undefined {
  return (request as { user?: { sub: string } }).user?.sub;
}

/** URL-safe team slug derived from a display name (lowercase-kebab). */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
}

function orgResponse(
  org: { id: string; handle: string; displayName: string; description: string | null; createdAt: Date },
  extra: { viewerRole: ViewerRole; memberCount: number; teamCount: number },
) {
  return {
    id: org.id,
    handle: org.handle,
    displayName: org.displayName,
    description: org.description,
    createdAt: org.createdAt.toISOString(),
    viewerRole: extra.viewerRole,
    memberCount: extra.memberCount,
    teamCount: extra.teamCount,
  };
}

type MembershipRow = {
  userId: string;
  role: string;
  createdAt: Date;
  user: { id: string; handle: string; displayName: string | null };
};

function memberResponse(m: MembershipRow) {
  return {
    id: m.user.id,
    handle: m.user.handle,
    displayName: m.user.displayName,
    role: m.role === "OWNER" ? ("OWNER" as const) : ("MEMBER" as const),
    joinedAt: m.createdAt.toISOString(),
  };
}

/**
 * Load an org by handle with its membership set, resolve the caller's role, and
 * short-circuit with 404 when the org doesn't exist. When `requireRole` is given
 * the caller must hold it (OWNER), else the reply is a 403 (member) or 404
 * (non-member — an org's existence isn't leaked to outsiders on a management route).
 */
async function loadOrgForManage(
  request: FastifyRequest,
  reply: FastifyReply,
  handle: string,
  requireRole: "OWNER" | "MEMBER",
) {
  const org = await prisma.organization.findUnique({
    where: { handle: handle.toLowerCase() },
    include: {
      memberships: { include: { user: userSelect }, orderBy: { createdAt: "asc" } },
      _count: { select: { teams: true } },
    },
  });
  if (!org) {
    reply.status(404).send({ error: "Organization not found" });
    return null;
  }
  const uid = viewerId(request);
  const mine = org.memberships.find((m) => m.userId === uid);
  if (!mine) {
    reply.status(404).send({ error: "Organization not found" });
    return null;
  }
  if (requireRole === "OWNER" && mine.role !== "OWNER") {
    reply.status(403).send({ error: "Organization owner access required" });
    return null;
  }
  return { org, myRole: mine.role as "OWNER" | "MEMBER" };
}

export async function orgRoutes(app: FastifyInstance) {
  // ── Create an org (creator becomes OWNER) ───────────────────────────────────
  app.post("/orgs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createOrgBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const handle = parsed.data.handle.toLowerCase();
    // Shared handle space: reject if a user OR another org already owns the handle.
    if (await isHandleTaken(handle)) {
      return reply.status(409).send({ error: "Handle already taken" });
    }
    try {
      const org = await prisma.organization.create({
        data: {
          handle,
          displayName: parsed.data.displayName?.trim() || parsed.data.handle,
          description: parsed.data.description?.trim() || null,
          memberships: { create: { userId: request.user.sub, role: "OWNER" } },
        },
      });
      return reply.status(201).send(
        orgResponse(org, { viewerRole: "OWNER", memberCount: 1, teamCount: 0 }),
      );
    } catch (e: unknown) {
      // Race: another request claimed the handle between the check and the insert.
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return reply.status(409).send({ error: "Handle already taken" });
      }
      throw e;
    }
  });

  // ── Orgs the caller belongs to (feeds the create-repo namespace picker) ──────
  app.get("/orgs/mine", { preHandler: [app.authenticate] }, async (request) => {
    const memberships = await prisma.orgMembership.findMany({
      where: { userId: request.user.sub },
      include: { org: { include: { _count: { select: { memberships: true, teams: true } } } } },
      orderBy: { org: { handle: "asc" } },
    });
    return {
      orgs: memberships.map((m) =>
        orgResponse(m.org, {
          viewerRole: m.role === "OWNER" ? "OWNER" : "MEMBER",
          memberCount: m.org._count.memberships,
          teamCount: m.org._count.teams,
        }),
      ),
    };
  });

  // ── Org profile: info + visible repos + (for members) the member list ────────
  app.get("/orgs/:handle", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const org = await prisma.organization.findUnique({
      where: { handle: handle.toLowerCase() },
      include: {
        memberships: { include: { user: userSelect }, orderBy: { createdAt: "asc" } },
        _count: { select: { teams: true } },
      },
    });
    if (!org) return reply.status(404).send({ error: "Organization not found" });

    const viewer = viewerId(request);
    const mine = viewer ? org.memberships.find((m) => m.userId === viewer) : undefined;
    const viewerRole: ViewerRole = mine ? (mine.role === "OWNER" ? "OWNER" : "MEMBER") : null;

    const repos = await prisma.repo.findMany({
      where: { orgId: org.id },
      orderBy: { updatedAt: "desc" },
      include: { ...repoAccessInclude, owner: { select: { handle: true } }, topics: { orderBy: { topic: "asc" }, select: { topic: true } } },
    });
    const visibleRepos = repos.filter((r) => canRead(r, viewer)).map((r) => repoResponse(r));

    return {
      org: orgResponse(org, {
        viewerRole,
        memberCount: org.memberships.length,
        teamCount: org._count.teams,
      }),
      // The member roster is member-only; outsiders see the org and its public repos.
      members: mine ? org.memberships.map(memberResponse) : [],
      repos: visibleRepos,
    };
  });

  // ── Org settings (OWNER) ─────────────────────────────────────────────────────
  app.patch("/orgs/:handle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = updateOrgBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle } = request.params as { handle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;

    const data: { displayName?: string; description?: string | null } = {};
    if (parsed.data.displayName !== undefined) data.displayName = parsed.data.displayName.trim();
    if (parsed.data.description !== undefined) {
      data.description = parsed.data.description === null ? null : parsed.data.description.trim() || null;
    }
    const org = Object.keys(data).length
      ? await prisma.organization.update({ where: { id: loaded.org.id }, data })
      : loaded.org;
    return orgResponse(org, {
      viewerRole: "OWNER",
      memberCount: loaded.org.memberships.length,
      teamCount: loaded.org._count.teams,
    });
  });

  // ── Membership management (OWNER) ────────────────────────────────────────────
  app.post("/orgs/:handle/members", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = addOrgMemberBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle } = request.params as { handle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;

    const user = await prisma.user.findUnique({ where: { handle: parsed.data.handle.toLowerCase() } });
    if (!user) return reply.status(404).send({ error: "User not found" });

    const membership = await prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: loaded.org.id, userId: user.id } },
      create: { orgId: loaded.org.id, userId: user.id, role: parsed.data.role },
      update: { role: parsed.data.role },
      include: { user: userSelect },
    });
    return reply.status(201).send(memberResponse(membership));
  });

  app.patch("/orgs/:handle/members/:memberHandle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = updateOrgMemberBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle, memberHandle } = request.params as { handle: string; memberHandle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;

    const target = loaded.org.memberships.find((m) => m.user.handle === memberHandle.toLowerCase());
    if (!target) return reply.status(404).send({ error: "Member not found" });
    // Guard the last owner: an org must always have at least one OWNER.
    if (target.role === "OWNER" && parsed.data.role !== "OWNER") {
      const owners = loaded.org.memberships.filter((m) => m.role === "OWNER").length;
      if (owners <= 1) return reply.status(400).send({ error: "An organization must have at least one owner" });
    }
    const membership = await prisma.orgMembership.update({
      where: { orgId_userId: { orgId: loaded.org.id, userId: target.userId } },
      data: { role: parsed.data.role },
      include: { user: userSelect },
    });
    return memberResponse(membership);
  });

  app.delete("/orgs/:handle/members/:memberHandle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, memberHandle } = request.params as { handle: string; memberHandle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;

    const target = loaded.org.memberships.find((m) => m.user.handle === memberHandle.toLowerCase());
    if (!target) return reply.status(404).send({ error: "Member not found" });
    if (target.role === "OWNER") {
      const owners = loaded.org.memberships.filter((m) => m.role === "OWNER").length;
      if (owners <= 1) return reply.status(400).send({ error: "An organization must have at least one owner" });
    }
    // Removing a member also drops them from every team in the org.
    await prisma.$transaction([
      prisma.teamMembership.deleteMany({
        where: { userId: target.userId, team: { orgId: loaded.org.id } },
      }),
      prisma.orgMembership.delete({
        where: { orgId_userId: { orgId: loaded.org.id, userId: target.userId } },
      }),
    ]);
    return reply.status(204).send();
  });

  // ── Teams ────────────────────────────────────────────────────────────────────
  app.get("/orgs/:handle/teams", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const org = await prisma.organization.findUnique({
      where: { handle: handle.toLowerCase() },
      include: { memberships: { select: { userId: true } } },
    });
    if (!org) return reply.status(404).send({ error: "Organization not found" });
    // Team structure is member-only.
    const viewer = viewerId(request);
    if (!viewer || !org.memberships.some((m) => m.userId === viewer)) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const teams = await prisma.team.findMany({
      where: { orgId: org.id },
      orderBy: { name: "asc" },
      include: {
        memberships: { include: { user: userSelect } },
        repoAccess: { include: { repo: { select: { id: true, name: true } } } },
      },
    });
    return { teams: teams.map(teamResponse) };
  });

  app.post("/orgs/:handle/teams", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createTeamBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle } = request.params as { handle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;

    const slug = (parsed.data.slug ?? slugify(parsed.data.name)).toLowerCase();
    if (!slug) return reply.status(400).send({ error: "Team slug could not be derived from the name" });
    try {
      const team = await prisma.team.create({
        data: { orgId: loaded.org.id, name: parsed.data.name.trim(), slug },
        include: {
          memberships: { include: { user: userSelect } },
          repoAccess: { include: { repo: { select: { id: true, name: true } } } },
        },
      });
      return reply.status(201).send(teamResponse(team));
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return reply.status(409).send({ error: "A team with this slug already exists" });
      }
      throw e;
    }
  });

  app.patch("/orgs/:handle/teams/:slug", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = updateTeamBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle, slug } = request.params as { handle: string; slug: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({ where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } } });
    if (!team) return reply.status(404).send({ error: "Team not found" });

    const data: { name?: string; slug?: string } = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
    if (parsed.data.slug !== undefined) data.slug = parsed.data.slug.toLowerCase();
    try {
      const updated = await prisma.team.update({
        where: { id: team.id },
        data,
        include: {
          memberships: { include: { user: userSelect } },
          repoAccess: { include: { repo: { select: { id: true, name: true } } } },
        },
      });
      return teamResponse(updated);
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return reply.status(409).send({ error: "A team with this slug already exists" });
      }
      throw e;
    }
  });

  app.delete("/orgs/:handle/teams/:slug", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, slug } = request.params as { handle: string; slug: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({ where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } } });
    if (!team) return reply.status(404).send({ error: "Team not found" });
    await prisma.team.delete({ where: { id: team.id } });
    return reply.status(204).send();
  });

  // ── Team membership ──────────────────────────────────────────────────────────
  app.post("/orgs/:handle/teams/:slug/members", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = addTeamMemberBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle, slug } = request.params as { handle: string; slug: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({ where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } } });
    if (!team) return reply.status(404).send({ error: "Team not found" });

    const member = loaded.org.memberships.find((m) => m.user.handle === parsed.data.handle.toLowerCase());
    // A team member must first be an org member.
    if (!member) return reply.status(400).send({ error: "User is not a member of this organization" });

    await prisma.teamMembership.upsert({
      where: { teamId_userId: { teamId: team.id, userId: member.userId } },
      create: { teamId: team.id, userId: member.userId },
      update: {},
    });
    const full = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      include: {
        memberships: { include: { user: userSelect } },
        repoAccess: { include: { repo: { select: { id: true, name: true } } } },
      },
    });
    return reply.status(201).send(teamResponse(full));
  });

  app.delete("/orgs/:handle/teams/:slug/members/:memberHandle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, slug, memberHandle } = request.params as { handle: string; slug: string; memberHandle: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({
      where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } },
      include: { memberships: { include: { user: userSelect } } },
    });
    if (!team) return reply.status(404).send({ error: "Team not found" });
    const target = team.memberships.find((m) => m.user.handle === memberHandle.toLowerCase());
    if (!target) return reply.status(404).send({ error: "Team member not found" });
    await prisma.teamMembership.delete({ where: { teamId_userId: { teamId: team.id, userId: target.userId } } });
    return reply.status(204).send();
  });

  // ── Team → repo access grants ────────────────────────────────────────────────
  app.post("/orgs/:handle/teams/:slug/repos", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = grantTeamRepoBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { handle, slug } = request.params as { handle: string; slug: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({ where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } } });
    if (!team) return reply.status(404).send({ error: "Team not found" });

    // A team may only be granted repos owned by its own org.
    const repo = await prisma.repo.findFirst({
      where: { name: parsed.data.repo.toLowerCase(), orgId: loaded.org.id },
      select: { id: true, name: true },
    });
    if (!repo) return reply.status(404).send({ error: "Repository not found in this organization" });

    await prisma.teamRepoAccess.upsert({
      where: { teamId_repoId: { teamId: team.id, repoId: repo.id } },
      create: { teamId: team.id, repoId: repo.id, role: parsed.data.role },
      update: { role: parsed.data.role },
    });
    const full = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      include: {
        memberships: { include: { user: userSelect } },
        repoAccess: { include: { repo: { select: { id: true, name: true } } } },
      },
    });
    return reply.status(201).send(teamResponse(full));
  });

  app.delete("/orgs/:handle/teams/:slug/repos/:repoName", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, slug, repoName } = request.params as { handle: string; slug: string; repoName: string };
    const loaded = await loadOrgForManage(request, reply, handle, "OWNER");
    if (!loaded) return;
    const team = await prisma.team.findUnique({ where: { orgId_slug: { orgId: loaded.org.id, slug: slug.toLowerCase() } } });
    if (!team) return reply.status(404).send({ error: "Team not found" });
    const repo = await prisma.repo.findFirst({
      where: { name: repoName.toLowerCase(), orgId: loaded.org.id },
      select: { id: true },
    });
    if (!repo) return reply.status(404).send({ error: "Repository not found in this organization" });
    const existing = await prisma.teamRepoAccess.findUnique({
      where: { teamId_repoId: { teamId: team.id, repoId: repo.id } },
    });
    if (!existing) return reply.status(404).send({ error: "Grant not found" });
    await prisma.teamRepoAccess.delete({ where: { teamId_repoId: { teamId: team.id, repoId: repo.id } } });
    return reply.status(204).send();
  });
}

type TeamRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  memberships: Array<{ user: { id: string; handle: string; displayName: string | null } }>;
  repoAccess: Array<{ role: string; repo: { id: string; name: string } }>;
};

function teamResponse(team: TeamRow) {
  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    createdAt: team.createdAt.toISOString(),
    members: team.memberships.map((m) => ({
      id: m.user.id,
      handle: m.user.handle,
      displayName: m.user.displayName,
    })),
    repos: team.repoAccess.map((a) => ({
      repoId: a.repo.id,
      name: a.repo.name,
      role: a.role === "WRITER" ? ("WRITER" as const) : ("READER" as const),
    })),
  };
}
