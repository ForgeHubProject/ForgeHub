/**
 * Account settings (#258): changing your username, exporting your data and
 * deleting your account.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
    organization: { findUnique: vi.fn() },
    orgMembership: { findMany: vi.fn(), count: vi.fn() },
    repo: { findMany: vi.fn(), update: vi.fn() },
    repoRedirect: { deleteMany: vi.fn(), upsert: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    star: { findMany: vi.fn() },
    follow: { findMany: vi.fn() },
    issue: { findMany: vi.fn() },
    pullRequest: { findMany: vi.fn() },
    issueComment: { findMany: vi.fn() },
    pullRequestComment: { findMany: vi.fn() },
    sSHKey: { findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    $executeRawUnsafe: vi.fn(),
  },
}));
vi.mock("../git-storage.js", async (orig) => ({
  ...(await orig<typeof import("../git-storage.js")>()),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { moveBareRepo, removeBareRepo } from "../git-storage.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ME = "user-me";
let app: FastifyInstance;
let session: string;
let hash: string;
beforeAll(async () => {
  app = await createTestServer();
  session = await authHeader(app, ME);
  hash = await bcrypt.hash("hunter22", 4);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue({ id: "pat", userId: ME, scopes: "repo:read,repo:write,admin", expiresAt: null } as never);
  vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);
});

const call = (method: "POST" | "GET" | "DELETE", url: string, payload?: object, authorization = session) =>
  app.inject({ method, url, headers: { authorization }, payload });

describe("change username", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({ id: ME, handle: "ada" } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
  });

  it("moves your repositories and leaves redirects behind", async () => {
    const updatedAt = new Date("2026-10-01");
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ id: "r1", name: "poster", storageKey: "ada/poster.git", updatedAt }] as never);
    const res = await call("POST", "/users/me/rename", { handle: "Lovelace" });
    expect(res.json()).toEqual({ handle: "lovelace" });
    expect(moveBareRepo).toHaveBeenCalledWith("ada/poster.git", "lovelace/poster.git");
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: ME }, data: { handle: "lovelace" } });
    expect(prisma.repo.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { storageKey: "lovelace/poster.git", updatedAt } });
    expect(vi.mocked(prisma.repoRedirect.upsert).mock.calls[0][0].create).toEqual({ ownerHandle: "ada", name: "poster", repoId: "r1" });
  });

  it("refuses a taken or reserved name, and tokens", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org" } as never);
    expect((await call("POST", "/users/me/rename", { handle: "acme" })).statusCode).toBe(409);
    expect((await call("POST", "/users/me/rename", { handle: "explore" })).statusCode).toBe(400);
    expect((await call("POST", "/users/me/rename", { handle: "ghost" })).statusCode).toBe(400);
    expect((await call("POST", "/users/me/rename", { handle: "x" }, "Bearer fhp_token")).statusCode).toBe(403);
    expect(moveBareRepo).not.toHaveBeenCalled();
  });

  it("puts the repositories back when the database update fails", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ id: "r1", name: "poster", storageKey: "ada/poster.git", updatedAt: new Date() }] as never);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("boom"));
    expect((await call("POST", "/users/me/rename", { handle: "lovelace" })).statusCode).toBe(500);
    expect(vi.mocked(moveBareRepo).mock.calls).toEqual([
      ["ada/poster.git", "lovelace/poster.git"],
      ["lovelace/poster.git", "ada/poster.git"],
    ]);
  });
});

describe("delete account", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({ id: ME, handle: "ada", passwordHash: hash } as never);
    vi.mocked(prisma.orgMembership.findMany).mockResolvedValue([]);
  });

  it("needs your username and password", async () => {
    expect((await call("DELETE", "/users/me", { confirm: "bob", password: "hunter22" })).statusCode).toBe(400);
    expect((await call("DELETE", "/users/me", { confirm: "ada", password: "wrong" })).statusCode).toBe(403);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it("won't leave an organization without an owner", async () => {
    vi.mocked(prisma.orgMembership.findMany).mockResolvedValue([{ orgId: "o1", org: { handle: "acme" } }] as never);
    vi.mocked(prisma.orgMembership.count).mockResolvedValue(1);
    const res = await call("DELETE", "/users/me", { confirm: "ada", password: "hunter22" });
    expect(res.statusCode).toBe(409);
    expect(res.json().organizations).toEqual(["acme"]);
  });

  it("credits what you wrote to the ghost and removes your repositories", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null); // no ghost yet
    vi.mocked(prisma.user.create).mockResolvedValue({ id: "ghost-id" } as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ storageKey: "ada/poster.git" }] as never);
    const res = await call("DELETE", "/users/me", { confirm: "ada", password: "hunter22" });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.user.create).mock.calls[0][0].data).toMatchObject({ handle: "ghost", passwordHash: "!" });
    const updates = vi.mocked(prisma.$executeRawUnsafe).mock.calls;
    expect(updates).toContainEqual(['UPDATE "Issue" SET "authorId" = ? WHERE "authorId" = ?', "ghost-id", ME]);
    expect(updates).toContainEqual(['UPDATE "Repo" SET "ownerId" = ? WHERE "ownerId" = ? AND "orgId" IS NOT NULL', "ghost-id", ME]);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: ME } });
    expect(removeBareRepo).toHaveBeenCalledWith("ada/poster.git");
  });

  it("refuses when a real person is called ghost", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "g", email: "someone@x.io" } as never);
    expect((await call("DELETE", "/users/me", { confirm: "ada", password: "hunter22" })).statusCode).toBe(500);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});

describe("export", () => {
  it("gives you your data as a JSON download, and refuses tokens", async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({ id: ME, handle: "ada", email: "ada@x.io", createdAt: new Date("2026-01-01") } as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([
      { name: "poster", description: null, visibility: "PUBLIC", createdAt: new Date("2026-02-01"), owner: { handle: "ada" }, org: null, topics: [{ topic: "design" }] },
    ] as never);
    for (const m of ["star", "follow", "issue", "pullRequest", "issueComment", "pullRequestComment", "sSHKey", "personalAccessToken"] as const) {
      vi.mocked(prisma[m].findMany as () => Promise<unknown[]>).mockResolvedValue([]);
    }
    const res = await call("GET", "/users/me/export");
    expect(res.headers["content-disposition"]).toContain("forgehub-ada-export.json");
    expect(res.json()).toMatchObject({ account: { handle: "ada", email: "ada@x.io" }, repositories: [{ fullName: "ada/poster", topics: ["design"] }] });
    expect((await call("GET", "/users/me/export", undefined, "Bearer fhp_token")).statusCode).toBe(403);
  });
});
