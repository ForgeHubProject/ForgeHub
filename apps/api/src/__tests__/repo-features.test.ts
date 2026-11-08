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
    issue: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("../git-storage.js", async (orig) => ({
  ...(await orig<typeof import("../git-storage.js")>()),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../license.js", () => ({ detectRepoLicense: vi.fn().mockResolvedValue(null) }));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { moveBareRepo } from "../git-storage.js";
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

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
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
      args.where.id === ME ? { handle: "ada" } : args.where.handle === "bob" ? { id: "bob" } : null) as never);
  });

  it("moves the repository to an organization you own, leaving a redirect", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", memberships: [{ userId: ME }] } as never);
    const res = await call("POST", "/repos/ada/poster/transfer", { newOwner: "acme" });
    expect(res.json()).toEqual({ fullName: "acme/poster" });
    expect(moveBareRepo).toHaveBeenCalledWith("ada/poster.git", "acme/poster.git");
    expect(vi.mocked(prisma.repo.update).mock.calls[0][0].data).toEqual({ orgId: "org-1", ownerId: ME, storageKey: "acme/poster.git" });
    expect(vi.mocked(prisma.repoRedirect.upsert).mock.calls[0][0].create).toEqual({ ownerHandle: "ada", name: "poster", repoId: "repo-1" });
  });

  it("refuses an organization you don't own, another person, and nobody", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", memberships: [] } as never);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "acme" })).statusCode).toBe(403);
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(personal() as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "bob" })).statusCode).toBe(400);
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(personal() as never);
    expect((await call("POST", "/repos/ada/poster/transfer", { newOwner: "nobody" })).statusCode).toBe(404);
    expect(moveBareRepo).not.toHaveBeenCalled();
  });
});
