/**
 * Settings for org repositories (#217).
 *
 * An org repo is administered by the org's OWNERs — not by whoever happened to
 * create it — and every settings route has to agree: the owner-scoped settings
 * and collaborator routes, branch protection, and the `viewerPermission` the
 * web app gates its Settings tab on. Before #217 the web compared handles (so an
 * org repo had no Settings for anyone), the settings and collaborator routes
 * could only find the caller's own personal repo, and branch protection,
 * protected tags, webhooks and deploy keys admitted the creator alone.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    repo: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    repoCollaborator: { findMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    protectedBranch: { upsert: vi.fn() },
  },
}));
vi.mock("../license.js", () => ({ detectRepoLicense: vi.fn().mockResolvedValue(null) }));
vi.mock("../watch-service.js", () => ({
  ensureImplicitWatch: vi.fn().mockResolvedValue(undefined),
  pruneWatchOnAccessLoss: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canAdmin, viewerPermission } from "../repo-access.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const OWNER = "org-owner"; // an org OWNER who did not create the repo
const CREATOR = "creator"; // created the repo, but is only a MEMBER of the org
const OUTSIDER = "outsider";

function orgRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    name: "tools",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: "acme/tools.git",
    ownerId: CREATOR,
    orgId: "org-1",
    forkedFromId: null,
    allowedMergeMethods: "merge,squash,rebase",
    defaultMergeMethod: "merge",
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: { handle: "creator" },
    collaborators: [],
    teamAccess: [],
    topics: [],
    _count: { stars: 0 },
    org: {
      id: "org-1",
      handle: "acme",
      memberships: [
        { userId: OWNER, role: "OWNER" },
        { userId: CREATOR, role: "MEMBER" },
      ],
    },
    ...overrides,
  };
}

describe("canAdmin / viewerPermission", () => {
  it("is the owner for a personal repo, and the org's OWNERs for an org repo", () => {
    expect(canAdmin({ ownerId: "alice", orgId: null }, "alice")).toBe(true);
    expect(canAdmin({ ownerId: "alice", orgId: null }, "bob")).toBe(false);
    const repo = orgRepo();
    expect(canAdmin(repo, OWNER)).toBe(true);
    // Creating an org repo doesn't make you its admin; being an org owner does.
    expect(canAdmin(repo, CREATOR)).toBe(false);
    expect(canAdmin(repo, undefined)).toBe(false);
  });

  it("names the strongest access the viewer holds", () => {
    const repo = orgRepo();
    expect(viewerPermission(repo, OWNER)).toBe("admin");
    expect(viewerPermission(repo, CREATOR)).toBe("write");
    expect(viewerPermission(repo, OUTSIDER)).toBe("read"); // public
    expect(viewerPermission(orgRepo({ visibility: "PRIVATE" }), OUTSIDER)).toBeNull();
  });
});

describe("org repo settings routes", () => {
  let app: FastifyInstance;
  const as = async (user: string) => ({ authorization: await authHeader(app, user) });

  beforeAll(async () => {
    app = await createTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(orgRepo() as never);
    vi.mocked(prisma.repo.update).mockResolvedValue(orgRepo({ description: "Shop tools" }) as never);
    vi.mocked(prisma.repo.count).mockResolvedValue(0 as never);
  });

  it("GET /repos/:org/:name tells the viewer what they may do", async () => {
    for (const [user, expected] of [
      [OWNER, "admin"],
      [CREATOR, "write"],
      [OUTSIDER, "read"],
    ] as const) {
      const res = await app.inject({ method: "GET", url: "/repos/acme/tools", headers: await as(user) });
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerPermission, user).toBe(expected);
    }
    const anon = await app.inject({ method: "GET", url: "/repos/acme/tools" });
    expect(anon.json().viewerPermission).toBe("read");
  });

  describe("PATCH /repos/:handle/:name/settings", () => {
    const patch = async (user: string, url = "/repos/acme/tools/settings") =>
      app.inject({ method: "PATCH", url, headers: await as(user), payload: { description: "Shop tools" } });

    it("lets an org owner change an org repo's settings", async () => {
      const res = await patch(OWNER);
      expect(res.statusCode).toBe(200);
      expect(prisma.repo.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "repo-1" }, data: { description: "Shop tools" } }),
      );
    });

    it("refuses the repo's creator when they are only a member, and changes nothing", async () => {
      const res = await patch(CREATOR);
      expect(res.statusCode).toBe(403);
      expect(prisma.repo.update).not.toHaveBeenCalled();
    });

    it("is a 404 for someone who can't see a private repo", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(orgRepo({ visibility: "PRIVATE" }) as never);
      expect((await patch(OUTSIDER)).statusCode).toBe(404);
      expect(prisma.repo.update).not.toHaveBeenCalled();
    });

    it("still works for a personal repo's owner", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(
        orgRepo({ ownerId: "alice", orgId: null, org: null, owner: { handle: "alice" } }) as never,
      );
      expect((await patch("alice", "/repos/alice/tools/settings")).statusCode).toBe(200);
    });
  });

  describe("/repos/:handle/:name/collaborators", () => {
    const bob = { id: "bob-1", handle: "bob", email: "bob@example.com", displayName: null };

    it("lets an org owner list, add and remove collaborators", async () => {
      vi.mocked(prisma.repoCollaborator.findMany).mockResolvedValue([
        { id: "c1", role: "WRITER", createdAt: new Date(), user: bob },
      ] as never);
      const list = await app.inject({ method: "GET", url: "/repos/acme/tools/collaborators", headers: await as(OWNER) });
      expect(list.statusCode).toBe(200);
      expect(list.json().collaborators.map((c: { user: { handle: string } }) => c.user.handle)).toEqual(["bob"]);

      vi.mocked(prisma.user.findUnique).mockResolvedValue(bob as never);
      vi.mocked(prisma.repoCollaborator.upsert).mockResolvedValue({ id: "c1", role: "WRITER", createdAt: new Date(), user: bob } as never);
      const add = await app.inject({
        method: "POST",
        url: "/repos/acme/tools/collaborators",
        headers: await as(OWNER),
        payload: { handle: "bob", role: "writer" },
      });
      expect(add.statusCode).toBe(201);
      expect(prisma.repoCollaborator.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { repoId_userId: { repoId: "repo-1", userId: "bob-1" } } }),
      );

      vi.mocked(prisma.repoCollaborator.findUnique).mockResolvedValue({ id: "c1" } as never);
      const remove = await app.inject({ method: "DELETE", url: "/repos/acme/tools/collaborators/bob", headers: await as(OWNER) });
      expect(remove.statusCode).toBe(204);
      expect(prisma.repoCollaborator.delete).toHaveBeenCalled();
    });

    it("refuses a member, without touching anything", async () => {
      const add = await app.inject({
        method: "POST",
        url: "/repos/acme/tools/collaborators",
        headers: await as(CREATOR),
        payload: { handle: "bob", role: "writer" },
      });
      expect(add.statusCode).toBe(403);
      expect(prisma.repoCollaborator.upsert).not.toHaveBeenCalled();
      const list = await app.inject({ method: "GET", url: "/repos/acme/tools/collaborators", headers: await as(CREATOR) });
      expect(list.statusCode).toBe(403);
    });
  });

  describe("branch protection", () => {
    const put = async (user: string) =>
      app.inject({
        method: "PUT",
        url: "/repos/acme/tools/branches/main/protection",
        headers: await as(user),
        payload: { requirePullRequest: true },
      });

    it("lets an org owner protect a branch of an org repo they didn't create", async () => {
      expect((await put(OWNER)).statusCode).toBe(200);
      expect(prisma.protectedBranch.upsert).toHaveBeenCalled();
    });

    it("refuses the creator who is only a member", async () => {
      expect((await put(CREATOR)).statusCode).toBe(403);
      expect(prisma.protectedBranch.upsert).not.toHaveBeenCalled();
    });
  });
});
