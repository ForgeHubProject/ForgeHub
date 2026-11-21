/**
 * More repository settings (#256): Issues and Projects on or off, the pull
 * request switches, the default merge messages, and transferring ownership.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    repo: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), count: vi.fn().mockResolvedValue(0), update: vi.fn() },
    pullRequest: { findFirst: vi.fn() },
    repoRedirect: { deleteMany: vi.fn(), upsert: vi.fn() },
    repoTransfer: { upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    repoCollaborator: { deleteMany: vi.fn() },
    issue: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("../git-storage.js", async (orig) => ({
  ...(await orig<typeof import("../git-storage.js")>()),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../license.js", () => ({ detectRepoLicense: vi.fn().mockResolvedValue(null) }));
vi.mock("../blocks.js", async (orig) => ({ ...(await orig<typeof import("../blocks.js")>()), isBlocked: vi.fn().mockResolvedValue(false) }));
vi.mock("../repo-transfer-mail.js", () => ({ sendRepoTransferEmail: vi.fn().mockResolvedValue(undefined) }));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { moveBareRepo } from "../git-storage.js";
import { isBlocked } from "../blocks.js";
import { sendRepoTransferEmail } from "../repo-transfer-mail.js";
import { defaultMergeMessage, defaultSquashMessage } from "../pull-merge.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ME = "user-me";
const personal = (overrides: Record<string, unknown> = {}) => ({
  id: "repo-1", name: "poster", description: null, visibility: "PUBLIC", storageKey: "ada/poster.git", ownerId: ME, orgId: null,
  forkedFromId: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
  owner: { handle: "ada" }, org: null, collaborators: [], teamAccess: [], topics: [], _count: { stars: 0 },
  ...overrides,
});

let app: FastifyInstance;
let token: string;
beforeAll(async () => {
  app = await createTestServer();
  token = await authHeader(app, ME);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.count).mockResolvedValue(0);
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: token }, payload });

describe("default merge messages", () => {
  const pr = { number: 7, title: "New headline", fromBranch: "headline", toBranch: "main", description: "Bolder, shorter." };
  it("follow the repository's choice", () => {
    expect(defaultMergeMessage("default", pr)).toBe("Merge 'headline' into 'main' (#7)");
    expect(defaultMergeMessage("title", pr)).toBe("New headline (#7)");
    expect(defaultMergeMessage("title_description", pr)).toBe("New headline (#7)\n\nBolder, shorter.");
    expect(defaultSquashMessage("default", pr, "* a\n* b")).toBe("New headline (#7)\n\n* a\n* b\n");
    expect(defaultSquashMessage("title", pr, "* a")).toBe("New headline (#7)\n");
    expect(defaultSquashMessage("title_description", { ...pr, description: null }, "* a")).toBe("New headline (#7)\n");
  });
});

describe("Issues and Projects switched off", () => {
  it("answer 404 on their routes, and nothing else changes", async () => {
    // Both switched off; the archived guard's own count stays 0.
    vi.mocked(prisma.repo.count).mockImplementation((async (args: { where: Record<string, unknown> }) =>
      args.where.hasIssues === false || args.where.hasProjects === false ? 1 : 0) as never);
    const res = await call("GET", "/repos/ada/poster/issues");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Issues are turned off for this repository");
    expect(vi.mocked(prisma.repo.count).mock.calls.map((c) => c[0]!.where)).toContainEqual(expect.objectContaining({ name: "poster", hasIssues: false }));
    expect((await call("POST", "/repos/ada/poster/projects", { name: "x" })).json().error).toBe("Projects are turned off for this repository");
  });
});

describe("settings", () => {
  it("save the switches and messages, and refuse unknown message styles", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(personal() as never);
    vi.mocked(prisma.repo.update).mockResolvedValue(personal({ hasIssues: false, squashCommitMessage: "title" }) as never);
    const res = await call("PATCH", "/repos/ada/poster/settings", { hasIssues: false, allowAutoMerge: false, squashCommitMessage: "title" });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.repo.update).mock.calls[0][0].data).toMatchObject({ hasIssues: false, allowAutoMerge: false, squashCommitMessage: "title" });
    expect(res.json()).toMatchObject({ hasIssues: false, squashCommitMessage: "title" });
    expect((await call("PATCH", "/repos/ada/poster/settings", { mergeCommitMessage: "shout" })).statusCode).toBe(400);
  });

  it("refuse auto-merge when it's turned off", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(personal({ allowAutoMerge: false }) as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue({ id: "pr", state: "OPEN" } as never);
    const res = await call("POST", "/repos/ada/poster/pulls/1/auto-merge", {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Auto-merge is turned off for this repository");
  });
});

describe("transfer ownership", () => {
  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(personal() as never).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { id?: string; handle?: string } }) =>
      args.where.id === ME ? { handle: "ada" } : args.where.handle === "bob" ? { id: "bob", email: "bob@example.test" } : null) as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    vi.mocked(isBlocked).mockResolvedValue(false);
  });

  it("moves the repository to an organization you own, leaving a redirect", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", memberships: [{ userId: ME }] } as never);
    const res = await call("POST", "/repos/ada/poster/transfer", { newOwner: "acme" });
    expect(res.json()).toEqual({ fullName: "acme/poster" });
    expect(moveBareRepo).toHaveBeenCalledWith("ada/poster.git", "acme/poster.git");
    expect(vi.mocked(prisma.repo.update).mock.calls[0][0].data).toEqual({ orgId: "org-1", ownerId: ME, storageKey: "acme/poster.git" });
    expect(vi.mocked(prisma.repoRedirect.upsert).mock.calls[0][0].create).toEqual({ ownerHandle: "ada", name: "poster", repoId: "repo-1" });
  });

  it("a move settles a transfer still waiting for someone", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", memberships: [{ userId: ME }] } as never);
    await call("POST", "/repos/ada/poster/transfer", { newOwner: "acme" });
    expect(prisma.repoTransfer.deleteMany).toHaveBeenCalledWith({ where: { repoId: "repo-1" } });
  });

  it("refuses an organization you don't own, and nobody", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", memberships: [] } as never);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "acme" })).statusCode).toBe(403);
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(personal() as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "nobody" })).statusCode).toBe(404);
    expect(moveBareRepo).not.toHaveBeenCalled();
  });

  it("to another person: asks them, and nothing moves until they accept", async () => {
    const before = Date.now();
    const res = await call("POST", "/repos/ada/poster/transfer", { newOwner: "Bob" });
    expect(res.statusCode).toBe(202);
    const { pending } = res.json() as { pending: { to: string; expiresAt: string } };
    expect(pending.to).toBe("bob");
    // A day, as on GitHub.
    expect(Date.parse(pending.expiresAt) - before).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
    expect(Date.parse(pending.expiresAt) - before).toBeLessThanOrEqual(24 * 3600_000 + 5000);
    const upsert = vi.mocked(prisma.repoTransfer.upsert).mock.calls[0]![0];
    expect(upsert.where).toEqual({ repoId: "repo-1" });
    expect(upsert.create).toMatchObject({ repoId: "repo-1", fromUserId: ME, toUserId: "bob", fromHandle: "ada" });
    expect(sendRepoTransferEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "bob@example.test", fromHandle: "ada", repoFullName: "ada/poster" }));
    expect(moveBareRepo).not.toHaveBeenCalled();
    expect(prisma.repo.update).not.toHaveBeenCalled();
  });

  it("to another person: not if they blocked you, or already have a repository with that name", async () => {
    vi.mocked(isBlocked).mockResolvedValueOnce(true);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "bob" })).statusCode).toBe(403);
    expect(isBlocked).toHaveBeenCalledWith("bob", ME);
    vi.mocked(prisma.repo.findFirst).mockReset().mockResolvedValueOnce(personal() as never).mockResolvedValueOnce({ id: "bobs-poster" } as never);
    const res = await call("POST", "/repos/ada/poster/transfer", { newOwner: "bob" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/bob already has a repository called poster/);
    expect(prisma.repoTransfer.upsert).not.toHaveBeenCalled();
  });

  it("the settings page sees the waiting transfer and can cancel it", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce({ expiresAt: new Date(Date.now() + 3600_000), toUser: { handle: "bob" } } as never);
    const res = await call("GET", "/repos/ada/poster/transfer");
    expect(res.json().pending).toMatchObject({ to: "bob" });
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(personal() as never);
    expect((await call("DELETE", "/repos/ada/poster/transfer")).statusCode).toBe(204);
    expect(prisma.repoTransfer.deleteMany).toHaveBeenCalledWith({ where: { repoId: "repo-1" } });
  });

  it("an expired request shows as none", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce({ expiresAt: new Date(Date.now() - 1000), toUser: { handle: "bob" } } as never);
    expect((await call("GET", "/repos/ada/poster/transfer")).json()).toEqual({ pending: null });
  });
});

describe("a transfer request sent to you", () => {
  const waiting = (overrides: Record<string, unknown> = {}) => ({
    id: "t1", toUserId: ME, fromHandle: "bob", expiresAt: new Date(Date.now() + 3600_000),
    repo: { id: "repo-9", name: "cave", storageKey: "bob/cave.git", archivedAt: null, importStatus: null, owner: { handle: "bob" }, org: null },
    ...overrides,
  });
  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockReset().mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { id?: string } }) => (args.where.id === ME ? { handle: "ada" } : null)) as never);
  });

  it("is listed while it's within its day", async () => {
    vi.mocked(prisma.repoTransfer.findMany).mockResolvedValueOnce([
      { id: "t1", expiresAt: new Date("2026-11-22T10:00:00Z"), fromHandle: "bob", fromUser: { handle: "bob" }, repo: { name: "cave", visibility: "PRIVATE", description: "Levels" } },
    ] as never);
    const res = await call("GET", "/user/repo-transfers");
    expect(res.json()).toEqual({
      transfers: [{ id: "t1", repoFullName: "bob/cave", visibility: "private", description: "Levels", from: "bob", expiresAt: "2026-11-22T10:00:00.000Z" }],
    });
    const where = vi.mocked(prisma.repoTransfer.findMany).mock.calls[0]![0]!.where as { toUserId: string; expiresAt: { gt: Date } };
    expect(where.toUserId).toBe(ME);
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("accepting moves the repository to you, leaving a redirect, and drops your collaborator seat", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting() as never);
    const res = await call("POST", "/user/repo-transfers/t1/accept");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fullName: "ada/cave" });
    expect(moveBareRepo).toHaveBeenCalledWith("bob/cave.git", "ada/cave.git");
    expect(vi.mocked(prisma.repo.update).mock.calls[0]![0].data).toEqual({ orgId: null, ownerId: ME, storageKey: "ada/cave.git" });
    expect(vi.mocked(prisma.repoRedirect.upsert).mock.calls[0]![0].create).toEqual({ ownerHandle: "bob", name: "cave", repoId: "repo-9" });
    expect(prisma.repoCollaborator.deleteMany).toHaveBeenCalledWith({ where: { repoId: "repo-9", userId: ME } });
    expect(prisma.repoTransfer.deleteMany).toHaveBeenCalledWith({ where: { repoId: "repo-9" } });
  });

  it("only its recipient can answer it", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting({ toUserId: "someone-else" }) as never);
    expect((await call("POST", "/user/repo-transfers/t1/accept")).statusCode).toBe(404);
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting({ toUserId: "someone-else" }) as never);
    expect((await call("POST", "/user/repo-transfers/t1/decline")).statusCode).toBe(404);
    expect(moveBareRepo).not.toHaveBeenCalled();
    expect(prisma.repoTransfer.deleteMany).not.toHaveBeenCalled();
  });

  it("an expired one can't be accepted, and is cleared", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting({ expiresAt: new Date(Date.now() - 1000) }) as never);
    expect((await call("POST", "/user/repo-transfers/t1/accept")).statusCode).toBe(410);
    expect(prisma.repoTransfer.deleteMany).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(moveBareRepo).not.toHaveBeenCalled();
  });

  it("not if the repository has moved since, or you already have one with its name", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting({ repo: { ...waiting().repo, owner: { handle: "carol" } } }) as never);
    expect((await call("POST", "/user/repo-transfers/t1/accept")).statusCode).toBe(409);
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting() as never);
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce({ id: "adas-cave" } as never);
    const res = await call("POST", "/user/repo-transfers/t1/accept");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ada\/cave already exists/);
    expect(moveBareRepo).not.toHaveBeenCalled();
  });

  it("declining leaves the repository where it is", async () => {
    vi.mocked(prisma.repoTransfer.findUnique).mockResolvedValueOnce(waiting() as never);
    expect((await call("POST", "/user/repo-transfers/t1/decline")).statusCode).toBe(204);
    expect(prisma.repoTransfer.deleteMany).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(moveBareRepo).not.toHaveBeenCalled();
  });
});
