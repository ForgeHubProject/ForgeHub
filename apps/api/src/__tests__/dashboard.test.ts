/**
 * Your issues and pull requests across repositories (#255): which rows each
 * filter asks for, and that rows from repositories the caller can't read
 * never come back.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    issue: { findMany: vi.fn() },
    pullRequest: { findMany: vi.fn() },
    notification: { findMany: vi.fn() },
    pullRequestReviewerRequest: { findMany: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ME = "user-me";
const repo = (visibility: "PUBLIC" | "PRIVATE", ownerId = "someone") => ({
  id: `repo-${visibility}`, name: visibility === "PUBLIC" ? "open-repo" : "secret", visibility, ownerId,
  owner: { handle: "acme" }, org: null, collaborators: [], teamAccess: [],
});
const row = (number: number, r: ReturnType<typeof repo>) => ({
  number, title: `Item ${number}`, state: "OPEN", isDraft: false, fromBranch: "f", toBranch: "main",
  createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-02"),
  repo: r, author: { handle: "ada" }, assignee: null, labels: [], _count: { comments: 2 },
});

let app: FastifyInstance;
let token: string;
beforeAll(async () => {
  app = await createTestServer();
  token = await authHeader(app, ME);
});
afterAll(async () => { await app.close(); });
beforeEach(() => vi.clearAllMocks());

const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: token } });

describe("GET /user/issues", () => {
  it("lists issues assigned to the caller, dropping repositories they can't read", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValue([row(1, repo("PUBLIC")), row(2, repo("PRIVATE"))] as never);
    const res = await get("/user/issues?filter=assigned");
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([
      expect.objectContaining({ repo: { owner: "acme", name: "open-repo" }, number: 1, comments: 2, state: "open" }),
    ]);
    expect(vi.mocked(prisma.issue.findMany).mock.calls[0][0]).toMatchObject({ where: { assigneeId: ME, state: "OPEN" } });
  });

  it("finds mentions through the caller's notifications", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ subjectId: "issue-9" }] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
    await get("/user/issues?filter=mentioned&state=closed");
    expect(vi.mocked(prisma.notification.findMany).mock.calls[0][0]).toMatchObject({ where: { userId: ME, reason: "MENTIONED" } });
    expect(vi.mocked(prisma.issue.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ["issue-9"] }, state: "CLOSED" } });
  });

  it("refuses an unknown filter, and needs a signed-in caller", async () => {
    expect((await get("/user/issues?filter=everything")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/user/issues" })).statusCode).toBe(401);
  });
});

describe("GET /user/pulls", () => {
  it("lists outstanding review requests", async () => {
    vi.mocked(prisma.pullRequestReviewerRequest.findMany).mockResolvedValue([{ pullRequestId: "pr-4" }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([row(4, repo("PUBLIC"))] as never);
    const res = await get("/user/pulls?filter=review_requested");
    expect(res.json().pulls).toEqual([expect.objectContaining({ number: 4, isDraft: false, toBranch: "main" })]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.findMany).mock.calls[0][0]).toMatchObject({
      where: { userId: ME, fulfilledAt: null, dismissedAt: null },
    });
    expect(vi.mocked(prisma.pullRequest.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ["pr-4"] }, state: "OPEN" } });
  });

  it("'involves you' covers authored, assigned, requested, commented and reviewed", async () => {
    vi.mocked(prisma.pullRequestReviewerRequest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
    await get("/user/pulls?filter=involved&state=merged");
    const where = vi.mocked(prisma.pullRequest.findMany).mock.calls[0][0]!.where as { OR: unknown[]; state: string };
    expect(where.state).toBe("MERGED");
    expect(where.OR).toHaveLength(5);
  });
});
