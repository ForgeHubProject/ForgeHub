import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repo: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    repoCollaborator: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    star: { upsert: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    watch: { upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    notification: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), upsert: vi.fn() },
    release: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
    pullRequest: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    issue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    timelineEvent: { findMany: vi.fn(), create: vi.fn() },
    snapshot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn() },
    entity: { findMany: vi.fn().mockResolvedValue([]) },
    constraint: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/pub.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("../email-notify.js", () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { notifySubscribers, notifyUser } from "../notifications-service.js";
import { backfillImplicitWatches } from "../watch-service.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-01-15T10:00:00.000Z");

const PUBLIC_REPO = {
  id: "repo-pub", name: "pub", ownerId: "owner-1",
  visibility: "PUBLIC", storageKey: "alice/pub.git",
  collaborators: [], org: null, orgId: null, teamAccess: [],
};

const PRIVATE_REPO = {
  id: "repo-priv", name: "priv", ownerId: "owner-2",
  visibility: "PRIVATE", storageKey: "bob/priv.git",
  collaborators: [], org: null, orgId: null, teamAccess: [],
};

/** A full repo row as the starred-list / feed includes fetch it. */
function repoRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...PUBLIC_REPO,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    owner: { handle: "alice" },
    topics: [],
    _count: { stars: 2 },
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerToken: string;   // owner-1 — owns repo-pub
let strangerToken: string; // user-9 — no grants anywhere

beforeAll(async () => {
  app = await createTestServer();
  ownerToken = await authHeader(app, "owner-1");
  strangerToken = await authHeader(app, "user-9");
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(PUBLIC_REPO as never);
  vi.mocked(prisma.star.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.star.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.star.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.star.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.star.findMany).mockResolvedValue([]);
  vi.mocked(prisma.watch.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.watch.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.watch.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.watch.findMany).mockResolvedValue([]);
  vi.mocked(prisma.notification.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.notification.upsert).mockResolvedValue({} as never);
});

// ─── Stars ────────────────────────────────────────────────────────────────────

describe("PUT/DELETE /repos/:h/:r/star", () => {
  it("stars a readable repo and returns the grouped count", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(5 as never);
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/pub/star",
      headers: { authorization: strangerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ starred: true, starCount: 5 });
    expect(prisma.star.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { userId: "user-9", repoId: "repo-pub" } }),
    );
  });

  it("unstars and returns the updated count", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(4 as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/pub/star",
      headers: { authorization: strangerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ starred: false, starCount: 4 });
    expect(prisma.star.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-9", repoId: "repo-pub" } });
  });

  it("404s (and does not star) a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(PRIVATE_REPO as never);
    const res = await app.inject({
      method: "PUT", url: "/repos/bob/priv/star",
      headers: { authorization: strangerToken },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.star.upsert).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "PUT", url: "/repos/alice/pub/star" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /users/:handle/starred", () => {
  it("filters out starred repos the viewer cannot read", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u-star", handle: "starrer" } as never);
    vi.mocked(prisma.star.findMany).mockResolvedValue([
      { createdAt: NOW, repo: repoRow() },
      { createdAt: NOW, repo: repoRow({ ...PRIVATE_REPO, owner: { handle: "bob" } }) },
    ] as never);
    const res = await app.inject({
      method: "GET", url: "/users/starrer/starred",
      headers: { authorization: strangerToken },
    });
    expect(res.statusCode).toBe(200);
    const { repos } = res.json();
    expect(repos).toHaveLength(1);
    expect(repos[0].fullName).toBe("alice/pub");
    expect(repos[0].starCount).toBe(2);
    expect(repos[0].starredAt).toBe(NOW.toISOString());
  });

  it("404s for an unknown user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/users/nobody/starred" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Watching ─────────────────────────────────────────────────────────────────

describe("PUT/DELETE /repos/:h/:r/watch + GET /social", () => {
  it("sets an explicit level (upsert overwrites a previous choice)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/pub/watch",
      headers: { authorization: strangerToken },
      payload: { level: "ignore" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ watchLevel: "ignore" });
    expect(prisma.watch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: "user-9", repoId: "repo-pub", level: "IGNORE" },
        update: { level: "IGNORE" },
      }),
    );
  });

  it("rejects an unknown level", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/pub/watch",
      headers: { authorization: strangerToken },
      payload: { level: "loudly" },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.watch.upsert).not.toHaveBeenCalled();
  });

  it("DELETE clears the explicit row and reports the fallback level", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/pub/watch",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    // The owner falls back to the implicit ALL watch.
    expect(res.json()).toEqual({ watchLevel: "all" });
    expect(prisma.watch.deleteMany).toHaveBeenCalledWith({ where: { userId: "owner-1", repoId: "repo-pub" } });
  });

  it("GET /social reports the implicit default: ALL for the owner, PARTICIPATING otherwise", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(3 as never);
    const asOwner = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(asOwner.json()).toEqual({ starCount: 3, viewerStarred: false, watchLevel: "all" });

    const asStranger = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: strangerToken },
    });
    expect(asStranger.json()).toEqual({ starCount: 3, viewerStarred: false, watchLevel: "participating" });
  });

  it("GET /social surfaces an explicit level and the viewer's star", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.star.findUnique).mockResolvedValue({ id: "s1" } as never);
    vi.mocked(prisma.watch.findUnique).mockResolvedValue({ level: "IGNORE" } as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(res.json()).toEqual({ starCount: 3, viewerStarred: true, watchLevel: "ignore" });
  });
});

// ─── notifySubscribers: watch-driven fan-out ──────────────────────────────────

describe("notifySubscribers (watch-driven)", () => {
  const EVENT = {
    actorId: "actor-1", repoId: "repo-pub", subjectType: "ISSUE" as const,
    subjectId: "issue-1", subjectTitle: "Hello", reason: "SUBSCRIBED" as const,
  };

  function notifiedUserIds(): string[] {
    return vi.mocked(prisma.notification.upsert).mock.calls.map(
      (c) => (c[0] as { create: { userId: string } }).create.userId,
    );
  }

  it("notifies explicit ALL watchers plus row-less owner/collaborators, excluding the actor", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({
      ownerId: "owner-1", collaborators: [{ userId: "collab-1" }],
    } as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "fan-1", level: "ALL" },       // outside watcher, opted in
      { userId: "actor-1", level: "ALL" },     // the actor — never self-notified
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds().sort()).toEqual(["collab-1", "fan-1", "owner-1"]);
  });

  it("IGNORE mutes the repo-wide fan-out even for the owner", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({
      ownerId: "owner-1", collaborators: [{ userId: "collab-1" }],
    } as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "owner-1", level: "IGNORE" },
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds()).toEqual(["collab-1"]);
  });

  it("PARTICIPATING keeps a collaborator out of the fan-out", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({
      ownerId: "owner-1", collaborators: [{ userId: "collab-1" }],
    } as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "collab-1", level: "PARTICIPATING" },
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds()).toEqual(["owner-1"]);
  });
});

describe("notifyUser (direct reasons)", () => {
  const EVENT = {
    actorId: "actor-1", repoId: "repo-pub", subjectType: "ISSUE" as const,
    subjectId: "issue-1", subjectTitle: "Hello", reason: "MENTIONED" as const,
  };

  it("delivers when the target has no watch row", async () => {
    await notifyUser("user-9", EVENT);
    expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
  });

  it("IGNORE actually mutes: even a mention is suppressed", async () => {
    vi.mocked(prisma.watch.findUnique).mockResolvedValue({ level: "IGNORE" } as never);
    await notifyUser("user-9", EVENT);
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });
});

// ─── Implicit-watch backfill ──────────────────────────────────────────────────

describe("backfillImplicitWatches", () => {
  it("upserts an ALL row for every owner + collaborator without clobbering explicit levels", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([
      { id: "r1", ownerId: "owner-1", collaborators: [{ userId: "collab-1" }] },
      { id: "r2", ownerId: "owner-2", collaborators: [] },
    ] as never);

    await backfillImplicitWatches();

    expect(prisma.watch.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.watch.upsert).toHaveBeenCalledWith({
      where: { userId_repoId: { userId: "collab-1", repoId: "r1" } },
      create: { userId: "collab-1", repoId: "r1", level: "ALL" },
      // The empty update is the point: an explicit PARTICIPATING/IGNORE choice survives.
      update: {},
    });
  });

  it("is best-effort per row: one failure does not abort the rest", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([
      { id: "r1", ownerId: "owner-1", collaborators: [{ userId: "collab-1" }] },
    ] as never);
    vi.mocked(prisma.watch.upsert)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({} as never);

    await expect(backfillImplicitWatches()).resolves.toBeUndefined();
    expect(prisma.watch.upsert).toHaveBeenCalledTimes(2);
  });
});

// ─── Feed ─────────────────────────────────────────────────────────────────────

describe("GET /feed", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/feed" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty when nothing is watched or starred", async () => {
    const res = await app.inject({ method: "GET", url: "/feed", headers: { authorization: strangerToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], page: 1, perPage: 25, hasMore: false });
    expect(prisma.repo.findMany).not.toHaveBeenCalled();
  });

  it("excludes IGNORE-watched repos from the candidate set", async () => {
    vi.mocked(prisma.watch.findMany).mockResolvedValue([{ repoId: "repo-pub", level: "IGNORE" }] as never);
    const res = await app.inject({ method: "GET", url: "/feed", headers: { authorization: strangerToken } });
    expect(res.json().items).toEqual([]);
    expect(prisma.repo.findMany).not.toHaveBeenCalled();
  });

  it("drops starred repos the caller can no longer read BEFORE querying events", async () => {
    vi.mocked(prisma.star.findMany).mockResolvedValue([
      { repoId: "repo-pub" }, { repoId: "repo-priv" },
    ] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([
      { ...PUBLIC_REPO, owner: { handle: "alice" } },
      { ...PRIVATE_REPO, owner: { handle: "bob" } },
    ] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      { id: "i1", repoId: "repo-pub", number: 7, title: "Add wings", createdAt: NOW, author: { handle: "alice" } },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/feed", headers: { authorization: strangerToken } });
    expect(res.statusCode).toBe(200);

    // The unreadable private repo never reaches any event query…
    const issueWhere = vi.mocked(prisma.issue.findMany).mock.calls[0]![0] as { where: { repoId: { in: string[] } } };
    expect(issueWhere.where.repoId.in).toEqual(["repo-pub"]);
    const eventWhere = vi.mocked(prisma.timelineEvent.findMany).mock.calls[0]![0] as { where: { repoId: { in: string[] } } };
    expect(eventWhere.where.repoId.in).toEqual(["repo-pub"]);

    // …and the items all come from the readable one.
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "issue_opened", repo: { ownerHandle: "alice", name: "pub" },
      actor: "alice", number: 7, title: "Add wings",
    });
  });

  it("merges sources newest-first, resolves timeline subject titles, and paginates", async () => {
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      { id: "i1", repoId: "repo-pub", number: 7, title: "Add wings", createdAt: new Date("2026-01-15T09:00:00Z"), author: { handle: "alice" } },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany)
      // Base: the pr_opened source stays empty (also covers the page-2 request).
      .mockResolvedValue([] as never)
      // First call: the pr_opened source; second: the subject-title lookup.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ repoId: "repo-pub", number: 3, title: "Fix hinge" }] as never);
    vi.mocked(prisma.release.findMany).mockResolvedValue([
      { id: "rel1", repoId: "repo-pub", tagName: "v1.0.0", name: "First!", createdAt: new Date("2026-01-15T08:00:00Z"), author: { handle: "alice" } },
    ] as never);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([
      {
        id: "e1", repoId: "repo-pub", subjectType: "PULL_REQUEST", subjectNumber: 3, kind: "merged",
        data: JSON.stringify({ actorHandle: "carol", sha: "abc1234" }), createdAt: new Date("2026-01-15T10:00:00Z"),
      },
    ] as never);

    const res = await app.inject({ method: "GET", url: "/feed?per_page=2", headers: { authorization: strangerToken } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { type: string }) => i.type)).toEqual(["timeline", "issue_opened"]);
    expect(body.items[0]).toMatchObject({
      kind: "merged", actor: "carol", subjectType: "pull_request", number: 3, title: "Fix hinge",
    });
    expect(body.hasMore).toBe(true);

    // Page 2 carries the remaining release.
    const page2 = await app.inject({ method: "GET", url: "/feed?per_page=2&page=2", headers: { authorization: strangerToken } });
    expect(page2.json().items.map((i: { type: string }) => i.type)).toEqual(["release"]);
    expect(page2.json().hasMore).toBe(false);
  });
});
