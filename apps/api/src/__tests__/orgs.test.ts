import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    orgMembership: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    team: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    teamMembership: { upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    teamRepoAccess: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    repo: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn((handle: string, name: string) => `${handle}/${name}.git`),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo.git"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$hashed$"), compare: vi.fn().mockResolvedValue(true) },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER = "user-owner";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";

const ORG = { id: "org-1", handle: "acme", displayName: "Acme", description: null, createdAt: new Date(), updatedAt: new Date() };

function membership(userId: string, role: "OWNER" | "MEMBER", handle: string) {
  return { userId, role, createdAt: new Date(), user: { id: userId, handle, displayName: null } };
}

/** An org row as returned by loadOrgForManage / the profile route include. */
function orgWithMembers(memberships: ReturnType<typeof membership>[], teamCount = 0) {
  return { ...ORG, memberships, _count: { teams: teamCount } };
}

let app: FastifyInstance;
beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]); });

// ─── POST /orgs — creation + handle-space collision ──────────────────────────

describe("POST /orgs", () => {
  it("creates an org and makes the creator an OWNER", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never); // handle free (user table)
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null as never); // handle free (org table)
    vi.mocked(prisma.organization.create).mockResolvedValue(ORG as never);

    const res = await app.inject({
      method: "POST",
      url: "/orgs",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { handle: "acme", displayName: "Acme" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.handle).toBe("acme");
    expect(body.viewerRole).toBe("OWNER");
    // The membership was created inline with the org at OWNER.
    const createArg = vi.mocked(prisma.organization.create).mock.calls[0][0] as {
      data: { memberships?: { create?: { userId: string; role: string } } };
    };
    expect(createArg.data.memberships?.create).toMatchObject({ userId: OWNER, role: "OWNER" });
  });

  it("409s when the handle is already taken by a USER (collision direction 1)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u1", handle: "acme" } as never);
    const res = await app.inject({
      method: "POST",
      url: "/orgs",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { handle: "acme" },
    });
    expect(res.statusCode).toBe(409);
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });

  it("409s when the handle is already taken by another ORG", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(ORG as never);
    const res = await app.inject({
      method: "POST",
      url: "/orgs",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { handle: "acme" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app.inject({ method: "POST", url: "/orgs", payload: { handle: "acme" } });
    expect(res.statusCode).toBe(401);
  });
});

// ─── GET /orgs/:handle — profile visibility ──────────────────────────────────

describe("GET /orgs/:handle", () => {
  it("returns the member roster to a member", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner"), membership(MEMBER, "MEMBER", "member")]) as never,
    );
    vi.mocked(prisma.repo.findMany).mockResolvedValue([] as never);
    const res = await app.inject({
      method: "GET",
      url: "/orgs/acme",
      headers: { authorization: await authHeader(app, MEMBER) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(2);
    expect(res.json().org.viewerRole).toBe("MEMBER");
  });

  it("hides the member roster from a non-member but still shows the org", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    vi.mocked(prisma.repo.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/orgs/acme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([]);
    expect(res.json().org.viewerRole).toBeNull();
  });

  it("404s an unknown org", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({ method: "GET", url: "/orgs/nope" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Membership CRUD auth ─────────────────────────────────────────────────────

describe("membership management authorization", () => {
  it("lets an OWNER add a member", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: MEMBER, handle: "member", displayName: null } as never);
    vi.mocked(prisma.orgMembership.upsert).mockResolvedValue(membership(MEMBER, "MEMBER", "member") as never);
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/members",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { handle: "member", role: "MEMBER" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("MEMBER");
  });

  it("403s a non-owner MEMBER trying to add a member", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner"), membership(MEMBER, "MEMBER", "member")]) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/members",
      headers: { authorization: await authHeader(app, MEMBER) },
      payload: { handle: "someone" },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.orgMembership.upsert).not.toHaveBeenCalled();
  });

  it("404s an outsider (org existence not leaked on a management route)", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/members",
      headers: { authorization: await authHeader(app, OUTSIDER) },
      payload: { handle: "someone" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to demote the last owner", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/orgs/acme/members/owner",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { role: "MEMBER" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Team CRUD auth ───────────────────────────────────────────────────────────

describe("team management authorization", () => {
  const teamRow = {
    id: "team-1", name: "Core", slug: "core", createdAt: new Date(),
    memberships: [] as unknown[], repoAccess: [] as unknown[],
  };

  it("lets an OWNER create a team (slug derived from name)", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    vi.mocked(prisma.team.create).mockResolvedValue(teamRow as never);
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/teams",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { name: "Core" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("core");
    expect(vi.mocked(prisma.team.create).mock.calls[0][0].data.slug).toBe("core");
  });

  it("403s a MEMBER creating a team", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner"), membership(MEMBER, "MEMBER", "member")]) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/teams",
      headers: { authorization: await authHeader(app, MEMBER) },
      payload: { name: "Core" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("grants a team access only to a repo owned by the org", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      orgWithMembers([membership(OWNER, "OWNER", "owner")]) as never,
    );
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ id: "team-1", orgId: ORG.id, slug: "core" } as never);
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null as never); // repo not in this org
    const res = await app.inject({
      method: "POST",
      url: "/orgs/acme/teams/core/repos",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { repo: "not-ours", role: "WRITER" },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.teamRepoAccess.upsert).not.toHaveBeenCalled();
  });
});

// ─── Create-repo-in-org (POST /repos with owner namespace) ────────────────────

describe("POST /repos into an org", () => {
  it("creates an org-owned repo for a member and namespaces it under the org handle", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "alice" } as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: ORG.id, handle: "acme" } as never);
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(
      { orgId: ORG.id, userId: MEMBER, role: "MEMBER" } as never,
    );
    vi.mocked(prisma.repo.create).mockResolvedValue({
      id: "repo-1", name: "widget", description: null, visibility: "PRIVATE",
      storageKey: "acme/widget.git", ownerId: MEMBER, orgId: ORG.id,
      createdAt: new Date(), updatedAt: new Date(),
      owner: { handle: "alice" }, org: { handle: "acme" },
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: await authHeader(app, MEMBER) },
      payload: { name: "widget", owner: "acme", visibility: "private" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ownerHandle).toBe("acme");
    expect(body.fullName).toBe("acme/widget");
    expect(body.orgId).toBe(ORG.id);
    // storageKey is keyed on the ORG handle, not the creator's.
    expect(vi.mocked(prisma.repo.create).mock.calls[0][0].data.storageKey).toBe("acme/widget.git");
  });

  it("403s creating in an org the caller is not a member of", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "alice" } as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: ORG.id, handle: "acme" } as never);
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: await authHeader(app, OUTSIDER) },
      payload: { name: "widget", owner: "acme" },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.repo.create).not.toHaveBeenCalled();
  });

  it("404s creating in a non-existent org", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "alice" } as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: await authHeader(app, MEMBER) },
      payload: { name: "widget", owner: "ghost" },
    });
    expect(res.statusCode).toBe(404);
  });
});
