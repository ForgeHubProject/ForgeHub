import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repo: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    repoCollaborator: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    notification: {
      findMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), upsert: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    release: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
    pullRequest: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    snapshot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn() },
    issue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    issueComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    issueLabel: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    label: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReview: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReviewComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    entity: { findMany: vi.fn().mockResolvedValue([]) },
    constraint: { findMany: vi.fn().mockResolvedValue([]) },
    tag: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/my-repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn().mockResolvedValue(true),
  defaultBranch: vi.fn().mockResolvedValue("main"),
  resolveBranchSha: vi.fn().mockResolvedValue("abc1234"),
  performMerge: vi.fn(),
  performMergeWithResolvedFiles: vi.fn(),
  branchShas: vi.fn().mockResolvedValue([]),
  listFilesDifferingBetweenBranches: vi.fn().mockResolvedValue([]),
  readFileAtBranch: vi.fn().mockResolvedValue(null),
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  tagExists: vi.fn().mockResolvedValue(true),
  cloneMirror: vi.fn(),
  git: vi.fn(),
  listCommits: vi.fn().mockResolvedValue([]),
  getCommit: vi.fn().mockResolvedValue(null),
  listTree: vi.fn().mockResolvedValue([]),
}));

vi.mock("../notifications-service.js", () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { rawSql } from "./helpers/raw-sql.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REPO = {
  id: "repo-1", name: "my-repo", ownerId: "user-1",
  visibility: "PUBLIC", storageKey: "alice/my-repo.git", collaborators: [],
};

const NOW = new Date("2026-01-15T10:00:00.000Z");

function makeNotif(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "notif-1",
    userId: "user-1",
    repoId: "repo-1",
    subjectType: "ISSUE",
    subjectId: "issue-1",
    subjectTitle: "Fix the bug",
    reason: "SUBSCRIBED",
    read: false,
    repo: { name: "my-repo", owner: { handle: "alice" } },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerToken: string;
let otherToken: string;

beforeAll(async () => {
  app = await createTestServer();
  ownerToken = await authHeader(app, "user-1");
  otherToken = await authHeader(app, "user-2");
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  // Subjects for the links (#258): the notifications here are about issue #7.
  vi.mocked(prisma.issue.findMany).mockResolvedValue([{ id: "issue-1", number: 7, state: "OPEN" }] as never);
});

// ─── GET /notifications ───────────────────────────────────────────────────────

describe("GET /notifications", () => {
  it("returns unread notifications by default", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([makeNotif()] as never);
    const res = await app.inject({
      method: "GET", url: "/notifications",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    const { notifications } = res.json();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].subjectType).toBe("issue");
    expect(notifications[0].reason).toBe("subscribed");
    expect(notifications[0].repo).toBe("alice/my-repo");
    expect(notifications[0].read).toBe(false);
    expect(notifications[0]).toMatchObject({ number: 7, state: "open" });
  });

  it("passes read:false filter when ?all is not set", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/notifications", headers: { authorization: ownerToken } });
    const call = vi.mocked(prisma.notification.findMany).mock.calls.at(-1)![0] as { where: Record<string, unknown> };
    expect(call.where.read).toBe(false);
  });

  it("omits read filter when ?all=true", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/notifications?all=true", headers: { authorization: ownerToken } });
    const call = vi.mocked(prisma.notification.findMany).mock.calls.at(-1)![0] as { where: Record<string, unknown> };
    expect(call.where.read).toBeUndefined();
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/notifications" });
    expect(res.statusCode).toBe(401);
  });
});

// ─── PATCH /notifications (mark all read) ────────────────────────────────────

describe("PATCH /notifications (mark all read)", () => {
  it("returns 204 and marks the inbox read without reordering it", async () => {
    vi.mocked(prisma.$executeRaw).mockResolvedValue(3 as never);
    const res = await app.inject({
      method: "PATCH", url: "/notifications",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    // Raw SQL: setting read must not bump updatedAt, which orders the inbox.
    expect(rawSql(prisma.$executeRaw).text).toContain('SET "read" = true');
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await app.inject({ method: "PATCH", url: "/notifications" });
    expect(res.statusCode).toBe(401);
  });
});

// ─── PATCH /notifications/:id (mark one read) ────────────────────────────────

describe("PATCH /notifications/:id", () => {
  it("marks a notification as read and returns it", async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(makeNotif() as never);
    vi.mocked(prisma.notification.findUniqueOrThrow).mockResolvedValue(makeNotif({ read: true }) as never);
    const res = await app.inject({
      method: "PATCH", url: "/notifications/notif-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().read).toBe(true);
  });

  it("returns 404 for unknown or other user's notification", async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH", url: "/notifications/notif-1",
      headers: { authorization: otherToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── DELETE /notifications/:id ────────────────────────────────────────────────

describe("DELETE /notifications/:id", () => {
  it("deletes the notification and returns 204", async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(makeNotif() as never);
    vi.mocked(prisma.notification.delete).mockResolvedValue(makeNotif() as never);
    const res = await app.inject({
      method: "DELETE", url: "/notifications/notif-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for unknown notification", async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE", url: "/notifications/bad-id",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /repos/:h/:r/notifications ──────────────────────────────────────────

describe("GET /repos/:h/:r/notifications", () => {
  it("returns repo-scoped notifications for the authenticated user", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([makeNotif()] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/notifications",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toHaveLength(1);
  });

  it("scopes query to the resolved repo", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
    await app.inject({
      method: "GET", url: "/repos/alice/my-repo/notifications",
      headers: { authorization: ownerToken },
    });
    const call = vi.mocked(prisma.notification.findMany).mock.calls.at(-1)![0] as { where: Record<string, unknown> };
    expect(call.where.repoId).toBe("repo-1");
  });

  it("returns 404 for unknown repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "GET", url: "/repos/nobody/no-repo/notifications",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/notifications" });
    expect(res.statusCode).toBe(401);
  });
});
