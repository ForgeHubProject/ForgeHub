/**
 * Settings (#258): notification preferences, saved replies and blocked users,
 * and what blocking stops.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    repo: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    watch: { findUnique: vi.fn() },
    notification: { findUnique: vi.fn(), upsert: vi.fn() },
    savedReply: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    block: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    follow: { deleteMany: vi.fn() },
    repoCollaborator: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("../email-notify.js", () => ({ sendNotificationEmail: vi.fn() }));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { sendNotificationEmail } from "../email-notify.js";
import { notifyUser, reasonPrefs, type EventParams } from "../notifications-service.js";
import { authHeader, createTestServer } from "./helpers/server.js";

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
});

const call = (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: token }, payload });

describe("notification preferences", () => {
  it("default every reason to on, and read stored choices", () => {
    expect(reasonPrefs(null, "MENTIONED")).toEqual({ web: true, email: true });
    expect(reasonPrefs('{"MENTIONED":{"email":false}}', "MENTIONED")).toEqual({ web: true, email: false });
    expect(reasonPrefs("not json", "COMMENT")).toEqual({ web: true, email: true });
  });

  it("merge an update into what's stored, and refuse unknown reasons", async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({ notificationPrefs: '{"COMMENT":{"web":false,"email":true}}' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ emailNotifications: true } as never);
    const res = await call("PUT", "/user/notification-preferences", { emailNotifications: true, reasons: { MENTIONED: { email: false } } });
    expect(res.json().reasons).toMatchObject({ COMMENT: { web: false, email: true }, MENTIONED: { web: true, email: false } });
    expect(vi.mocked(prisma.user.update).mock.calls[0][0].data).toMatchObject({ emailNotifications: true });
    expect((await call("PUT", "/user/notification-preferences", { reasons: { SPAM: { web: true } } })).statusCode).toBe(400);
    expect((await call("PUT", "/user/notification-preferences", { reasons: { COMMENT: { web: "yes" } } })).statusCode).toBe(400);
  });

  describe("when notifying", () => {
    const event: EventParams = { actorId: "bob", repoId: "r1", subjectType: "ISSUE", subjectId: "i1", subjectTitle: "Hi", reason: "MENTIONED" };
    beforeEach(() => {
      vi.mocked(prisma.repo.findUnique).mockResolvedValue({ id: "r1", visibility: "PUBLIC", ownerId: "x", collaborators: [] } as never);
      vi.mocked(prisma.watch.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.notification.findUnique).mockResolvedValue(null);
    });

    it("skip the inbox for a reason turned off there, but still email", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPrefs: '{"MENTIONED":{"web":false}}', blocking: [] } as never);
      await notifyUser(ME, event);
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
      expect(sendNotificationEmail).toHaveBeenCalledWith(ME, event);
    });

    it("skip email for a reason turned off there", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPrefs: '{"MENTIONED":{"email":false}}', blocking: [] } as never);
      await notifyUser(ME, event);
      expect(prisma.notification.upsert).toHaveBeenCalled();
      expect(sendNotificationEmail).not.toHaveBeenCalled();
    });

    it("never pass on anything from someone you blocked", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPrefs: null, blocking: [{ blockedId: "bob" }] } as never);
      await notifyUser(ME, event);
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
      expect(sendNotificationEmail).not.toHaveBeenCalled();
    });
  });
});

describe("saved replies", () => {
  it("are created, edited and deleted only by their owner", async () => {
    vi.mocked(prisma.savedReply.count).mockResolvedValue(0);
    vi.mocked(prisma.savedReply.create).mockResolvedValue({ id: "s1", title: "Thanks", body: "Thanks!" } as never);
    expect((await call("POST", "/user/replies", { title: " Thanks ", body: "Thanks!" })).statusCode).toBe(201);
    expect(vi.mocked(prisma.savedReply.create).mock.calls[0][0].data).toEqual({ userId: ME, title: "Thanks", body: "Thanks!" });
    expect((await call("POST", "/user/replies", { title: "", body: "x" })).statusCode).toBe(400);

    vi.mocked(prisma.savedReply.updateMany).mockResolvedValue({ count: 0 });
    expect((await call("PATCH", "/user/replies/other", { title: "T", body: "B" })).statusCode).toBe(404);
    expect(vi.mocked(prisma.savedReply.updateMany).mock.calls[0][0].where).toEqual({ id: "other", userId: ME });
    vi.mocked(prisma.savedReply.deleteMany).mockResolvedValue({ count: 1 });
    expect((await call("DELETE", "/user/replies/s1")).statusCode).toBe(204);
  });

  it("are capped", async () => {
    vi.mocked(prisma.savedReply.count).mockResolvedValue(100);
    expect((await call("POST", "/user/replies", { title: "T", body: "B" })).statusCode).toBe(400);
  });
});

describe("blocking", () => {
  it("ends follows both ways and collaborator access to your repositories", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "bob" } as never);
    expect((await call("PUT", "/user/blocks/Bob")).json()).toEqual({ blocked: true });
    expect(vi.mocked(prisma.follow.deleteMany).mock.calls[0][0]!.where).toEqual({
      OR: [{ followerId: ME, followingId: "bob" }, { followerId: "bob", followingId: ME }],
    });
    expect(vi.mocked(prisma.repoCollaborator.deleteMany).mock.calls[0][0]!.where).toEqual({ userId: "bob", repo: { ownerId: ME, orgId: null } });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: ME } as never);
    expect((await call("PUT", "/user/blocks/me")).statusCode).toBe(400);
  });

  it("keeps a blocked user out of the blocker's issues, pull requests and reactions", async () => {
    vi.mocked(prisma.block.findFirst).mockResolvedValue({ blockerId: "ada" } as never);
    for (const [method, url] of [
      ["POST", "/repos/ada/poster/issues"],
      ["POST", "/repos/ada/poster/issues/1/comments"],
      ["POST", "/repos/ada/poster/pulls/2/reviews"],
      ["PUT", "/repos/ada/poster/reactions"],
    ] as const) {
      const res = await call(method, url, { title: "x", body: "x" });
      expect(res.statusCode, url).toBe(403);
    }
    expect(vi.mocked(prisma.block.findFirst).mock.calls[0][0]!.where).toEqual({
      blockedId: ME,
      blocker: { handle: "ada", id: { not: ME }, repos: { some: { name: "poster", orgId: null } } },
    });
  });

  it("leaves everyone else alone", async () => {
    vi.mocked(prisma.block.findFirst).mockResolvedValue(null);
    const res = await call("POST", "/repos/ada/poster/issues", { title: "x" });
    expect(res.statusCode).toBe(404); // past the guard, to the route
  });
});
