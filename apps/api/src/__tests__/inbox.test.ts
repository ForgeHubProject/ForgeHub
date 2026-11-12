/**
 * The notifications inbox (#258): Inbox / Saved / Done, filters, bulk actions,
 * unsubscribing from a conversation, and the repositories you watch.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    repo: { findMany: vi.fn(), findUnique: vi.fn() },
    watch: { findMany: vi.fn(), findUnique: vi.fn() },
    issue: { findMany: vi.fn() },
    pullRequest: { findMany: vi.fn() },
    release: { findMany: vi.fn() },
    notification: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), upsert: vi.fn() },
    threadMute: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    $executeRaw: vi.fn(),
  },
}));
vi.mock("../email-notify.js", () => ({ sendNotificationEmail: vi.fn() }));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { notifyUser, type EventParams } from "../notifications-service.js";
import { authHeader, createTestServer } from "./helpers/server.js";
import { rawSql } from "./helpers/raw-sql.js";

const ME = "user-me";
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
  vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
  vi.mocked(prisma.notification.groupBy).mockResolvedValue([] as never);
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: token } });
const lastWhere = () => vi.mocked(prisma.notification.findMany).mock.calls.at(-1)![0]!.where;
const sqlOf = (i = -1) => rawSql(prisma.$executeRaw, i);

describe("listing", () => {
  it("keeps the bell's unread inbox, and filters by view, reason, repository and unread", async () => {
    await get("/notifications");
    expect(lastWhere()).toEqual({ userId: ME, done: false, read: false });
    await get("/notifications?view=inbox");
    expect(lastWhere()).toEqual({ userId: ME, done: false });
    await get("/notifications?view=saved&unread=true");
    expect(lastWhere()).toEqual({ userId: ME, saved: true, read: false });
    await get("/notifications?view=done&reason=review_requested&repo=acme/poster");
    expect(lastWhere()).toMatchObject({ userId: ME, done: true, reason: "REVIEW_REQUESTED", repo: { name: "poster" } });
    expect((await get("/notifications?reason=spam")).statusCode).toBe(400);
  });

  it("links each notification to its subject and counts the view per repository", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      {
        id: "n1", subjectType: "PULL_REQUEST", subjectId: "pr1", subjectTitle: "Poster", reason: "REVIEW_REQUESTED", read: false, saved: true, done: false,
        repoId: "r1", repo: { name: "poster", owner: { handle: "ada" }, org: { handle: "acme" } }, createdAt: new Date(), updatedAt: new Date(),
      },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([{ id: "pr1", number: 12, state: "MERGED" }] as never);
    vi.mocked(prisma.notification.groupBy).mockResolvedValue([{ repoId: "r1", _count: { _all: 3 } }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ id: "r1", name: "poster", owner: { handle: "ada" }, org: { handle: "acme" } }] as never);
    const res = (await get("/notifications?view=inbox")).json();
    // An org repository reads as the org's.
    expect(res.notifications[0]).toMatchObject({ repo: "acme/poster", number: 12, state: "merged", saved: true });
    expect(res.repos).toEqual([{ repo: "acme/poster", count: 3 }]);
  });
});

describe("sorting and subscriptions", () => {
  it("sorts oldest first on request", async () => {
    await get("/notifications?view=inbox&sort=oldest");
    expect(vi.mocked(prisma.notification.findMany).mock.calls.at(-1)![0]!.orderBy).toEqual({ updatedAt: "asc" });
  });

  it("splits the conversations reaching you from the ones you unsubscribed from", async () => {
    const row = (id: string, subjectId: string) => ({
      id, subjectType: "ISSUE", subjectId, subjectTitle: id, reason: "COMMENT", read: true, saved: false, done: false,
      repoId: "r1", repo: { name: "poster", owner: { handle: "ada" }, org: null }, createdAt: new Date(), updatedAt: new Date(),
    });
    vi.mocked(prisma.notification.findMany).mockResolvedValue([row("a", "i1"), row("b", "i2")] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.threadMute.findMany).mockResolvedValue([{ subjectId: "i2" }] as never);
    const res = (await get("/user/subscriptions")).json();
    expect(res.subscriptions.map((n: { id: string }) => n.id)).toEqual(["a"]);
    expect(res.unsubscribed.map((n: { id: string }) => n.id)).toEqual(["b"]);
  });
});

describe("actions", () => {
  it("apply in bulk to the caller's notifications only, without bumping their order", async () => {
    const res = await app.inject({ method: "POST", url: "/notifications/bulk", headers: { authorization: token }, payload: { ids: ["a", "b"], action: "done" } });
    expect(res.statusCode).toBe(204);
    const { text, values } = sqlOf();
    expect(text).toBe('UPDATE "Notification" SET "done" = true, "read" = true WHERE "userId" = ? AND "id" IN (?,?)');
    expect(values).toEqual([ME, "a", "b"]);
    expect((await app.inject({ method: "POST", url: "/notifications/bulk", headers: { authorization: token }, payload: { ids: ["a"], action: "nuke" } })).statusCode).toBe(400);
  });

  it("unsubscribe mutes the conversation and marks it done", async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: "n1" } as never);
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ subjectId: "issue-9" }] as never);
    expect((await app.inject({ method: "POST", url: "/notifications/n1/unsubscribe", headers: { authorization: token } })).statusCode).toBe(204);
    expect(vi.mocked(prisma.threadMute.upsert).mock.calls[0][0].create).toEqual({ userId: ME, subjectId: "issue-9" });
    expect(sqlOf().text).toContain('SET "done" = true');
  });
});

describe("delivery", () => {
  const event = (reason: EventParams["reason"]): EventParams => ({ actorId: "bob", repoId: "r1", subjectType: "ISSUE", subjectId: "issue-9", subjectTitle: "Hi", reason });
  beforeEach(() => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({ id: "r1", visibility: "PUBLIC", ownerId: "x", collaborators: [] } as never);
    vi.mocked(prisma.watch.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.notification.findUnique).mockResolvedValue(null);
  });

  it("keeps an unsubscribed conversation quiet, unless you're addressed directly", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPrefs: null, blocking: [], threadMutes: [{ subjectId: "issue-9" }] } as never);
    await notifyUser(ME, event("COMMENT"));
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
    await notifyUser(ME, event("MENTIONED"));
    expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
  });

  it("brings a done conversation back to the inbox on new activity", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPrefs: null, blocking: [], threadMutes: [] } as never);
    await notifyUser(ME, event("COMMENT"));
    expect(vi.mocked(prisma.notification.upsert).mock.calls[0][0].update).toMatchObject({ read: false, done: false });
  });
});

describe("watching", () => {
  it("lists explicit watches you can still read, and the repositories you watch by default", async () => {
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { level: "IGNORE", repo: { id: "r1", name: "noisy", visibility: "PUBLIC", ownerId: "x", owner: { handle: "acme" }, org: null, collaborators: [], teamAccess: [] } },
      { level: "ALL", repo: { id: "r2", name: "gone", visibility: "PRIVATE", ownerId: "x", owner: { handle: "acme" }, org: null, collaborators: [], teamAccess: [] } },
    ] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ id: "r3", name: "mine", owner: { handle: "me" }, org: null }] as never);
    expect((await get("/user/watching")).json().repos).toEqual([
      { repo: "acme/noisy", level: "ignore", explicit: true },
      { repo: "me/mine", level: "all", explicit: false },
    ]);
  });
});
