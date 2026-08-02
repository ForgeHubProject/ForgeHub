import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repo: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    repoCollaborator: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    star: { upsert: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    watch: { upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    backfillMarker: { findUnique: vi.fn(), create: vi.fn() },
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
  // notifySubscribers / notifyUser re-check read access, so the notify paths
  // need the access-relevant repo row too (issue #88).
  vi.mocked(prisma.repo.findUnique).mockResolvedValue(PUBLIC_REPO as never);
  vi.mocked(prisma.star.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.star.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.star.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.star.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.star.findMany).mockResolvedValue([]);
  vi.mocked(prisma.watch.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.watch.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.watch.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.watch.findMany).mockResolvedValue([]);
  vi.mocked(prisma.watch.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.backfillMarker.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.backfillMarker.create).mockResolvedValue({} as never);
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

  // Regression (adversarial review): the read used to be unbounded — every Star
  // row, each dragging the full access include (org memberships + team member
  // sets) along with it.
  it("bounds the read to the requested window and reports hasMore", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u-star", handle: "starrer" } as never);
    // 3 rows come back for a perPage of 2 — the extra one only answers hasMore.
    vi.mocked(prisma.star.findMany).mockResolvedValue([
      { createdAt: NOW, repo: repoRow() },
      { createdAt: NOW, repo: repoRow() },
      { createdAt: NOW, repo: repoRow() },
    ] as never);

    const res = await app.inject({ method: "GET", url: "/users/starrer/starred?page=2&per_page=2" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 2, perPage: 2, hasMore: true });
    expect(res.json().repos).toHaveLength(2);
    expect(prisma.star.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 2, take: 3 }),
    );
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
    // watcherCount: 0 explicit ALL rows + the row-less owner.
    expect(res.json()).toEqual({ watchLevel: "ignore", watcherCount: 1 });
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
    expect(res.json()).toEqual({ watchLevel: "all", watcherCount: 1 });
    expect(prisma.watch.deleteMany).toHaveBeenCalledWith({ where: { userId: "owner-1", repoId: "repo-pub" } });
  });

  it("GET /social reports the implicit default: ALL for the owner, PARTICIPATING otherwise", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(3 as never);
    const asOwner = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(asOwner.json()).toEqual({ starCount: 3, watcherCount: 1, viewerStarred: false, watchLevel: "all" });

    const asStranger = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: strangerToken },
    });
    expect(asStranger.json()).toEqual({ starCount: 3, watcherCount: 1, viewerStarred: false, watchLevel: "participating" });
  });

  it("GET /social surfaces an explicit level and the viewer's star", async () => {
    vi.mocked(prisma.star.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.star.findUnique).mockResolvedValue({ id: "s1" } as never);
    vi.mocked(prisma.watch.findUnique).mockResolvedValue({ level: "IGNORE" } as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(res.json()).toEqual({ starCount: 3, watcherCount: 1, viewerStarred: true, watchLevel: "ignore" });
  });

  // The watcher count mirrors the fan-out set exactly: explicit ALL rows, plus
  // owner/collaborators whose implicit ALL was never materialized.
  it("GET /social counts explicit ALL watchers plus row-less members", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      ...PUBLIC_REPO, collaborators: [{ userId: "collab-1" }, { userId: "collab-2" }],
    } as never);
    // collab-1 has a row (PARTICIPATING) — only collab-2 and the owner are implicit.
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "collab-1", level: "PARTICIPATING" },
      { userId: "w-1", level: "ALL" },
      { userId: "w-2", level: "ALL" },
      { userId: "w-3", level: "ALL" },
      { userId: "w-4", level: "ALL" },
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(res.json().watcherCount).toBe(6);
  });

  // Regression (adversarial review): the count was taken over raw Watch rows
  // without the read-access filter its own doc comment promised, so a stale ALL
  // row on a PRIVATE repo inflated a number that claims to mirror the fan-out.
  it("GET /social does not count a watcher who cannot read a PRIVATE repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      ...PRIVATE_REPO, ownerId: "owner-1", collaborators: [{ userId: "collab-1" }],
    } as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "collab-1", level: "ALL" },
      { userId: "ex-collab", level: "ALL" }, // access revoked, row outlived it
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/repos/bob/priv/social",
      headers: { authorization: ownerToken },
    });
    // owner-1 + collab-1 — ex-collab is subscribed but unreachable.
    expect(res.json().watcherCount).toBe(2);
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

  /** The fan-out repo as notifySubscribers loads it (access fields included). */
  function fanoutRepo(overrides: Record<string, unknown> = {}) {
    return {
      ...PUBLIC_REPO,
      ownerId: "owner-1",
      collaborators: [{ userId: "collab-1", role: "WRITER" }],
      ...overrides,
    };
  }

  it("notifies explicit ALL watchers plus row-less owner/collaborators, excluding the actor", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(fanoutRepo() as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "fan-1", level: "ALL" },       // outside watcher, opted in
      { userId: "actor-1", level: "ALL" },     // the actor — never self-notified
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds().sort()).toEqual(["collab-1", "fan-1", "owner-1"]);
  });

  it("IGNORE mutes the repo-wide fan-out even for the owner", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(fanoutRepo() as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "owner-1", level: "IGNORE" },
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds()).toEqual(["collab-1"]);
  });

  it("PARTICIPATING keeps a collaborator out of the fan-out", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(fanoutRepo() as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "collab-1", level: "PARTICIPATING" },
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds()).toEqual(["owner-1"]);
  });

  // Regression (adversarial review): a Watch row can outlive the grant that
  // justified it — collaborator removed, team access revoked, repo flipped to
  // private. Read access is therefore re-checked at delivery time.
  it("drops a stale ALL watcher who can no longer read a PRIVATE repo", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(
      fanoutRepo({ visibility: "PRIVATE", collaborators: [] }) as never,
    );
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "ex-collab", level: "ALL" }, // removed from the repo, row left behind
      { userId: "fan-1", level: "ALL" },     // never had access at all
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds()).toEqual(["owner-1"]);
  });

  it("keeps a PRIVATE-repo watcher whose access comes from a team grant", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(
      fanoutRepo({
        visibility: "PRIVATE",
        collaborators: [],
        teamAccess: [{ role: "READER", team: { memberships: [{ userId: "team-reader" }] } }],
      }) as never,
    );
    vi.mocked(prisma.watch.findMany).mockResolvedValue([
      { userId: "team-reader", level: "ALL" },
    ] as never);

    await notifySubscribers(EVENT);
    expect(notifiedUserIds().sort()).toEqual(["owner-1", "team-reader"]);
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

  // Regression (adversarial review): a direct reason must not leak a private
  // repo's subject title to someone whose read access is gone.
  it("suppresses a mention when the target cannot read the repo", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(PRIVATE_REPO as never);
    await notifyUser("user-9", EVENT);
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });

  it("still delivers to a PRIVATE-repo collaborator", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({
      ...PRIVATE_REPO, collaborators: [{ userId: "user-9", role: "READER" }],
    } as never);
    await notifyUser("user-9", EVENT);
    expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
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

  // Regression (adversarial review): this used to re-scan every repo on every
  // boot, so startup cost grew with instance size forever.
  it("marks itself complete and is a single lookup on the next boot", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([
      { id: "r1", ownerId: "owner-1", collaborators: [] },
    ] as never);

    await backfillImplicitWatches();
    expect(prisma.backfillMarker.create).toHaveBeenCalledWith({
      data: { name: "implicit-watches-v1" },
    });

    // Second boot: the marker exists, so nothing is scanned or written.
    vi.clearAllMocks();
    vi.mocked(prisma.backfillMarker.findUnique).mockResolvedValue({ name: "implicit-watches-v1" } as never);
    await backfillImplicitWatches();
    expect(prisma.repo.findMany).not.toHaveBeenCalled();
    expect(prisma.watch.upsert).not.toHaveBeenCalled();
  });

  it("scans in bounded batches rather than loading every repo at once", async () => {
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `r${from + i}`, ownerId: `owner-${from + i}`, collaborators: [] }));
    vi.mocked(prisma.repo.findMany)
      .mockResolvedValueOnce(batch(1, 200) as never)
      .mockResolvedValueOnce(batch(201, 5) as never);

    await backfillImplicitWatches();

    expect(prisma.repo.findMany).toHaveBeenCalledTimes(2);
    const first = vi.mocked(prisma.repo.findMany).mock.calls[0]![0] as Record<string, unknown>;
    expect(first).toMatchObject({ take: 200 });
    expect(first["cursor"]).toBeUndefined();
    // The second batch resumes after the last id of the first.
    expect(vi.mocked(prisma.repo.findMany).mock.calls[1]![0]).toMatchObject({
      take: 200, skip: 1, cursor: { id: "r200" },
    });
    expect(prisma.watch.upsert).toHaveBeenCalledTimes(205);
  });
});

// ─── Watch cleanup on access loss ─────────────────────────────────────────────
// Regression (adversarial review): removing a collaborator used to leave the
// materialized ALL row behind, so a private repo kept notifying an ex-member.

describe("DELETE /repos/:name/collaborators/:handle prunes the watch row", () => {
  const PRIV_OWNED = { ...PRIVATE_REPO, id: "repo-owned", ownerId: "owner-1" };

  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "collab-1", handle: "collab" } as never);
    vi.mocked(prisma.repoCollaborator.findUnique).mockResolvedValue({ id: "rc-1", role: "WRITER" } as never);
    vi.mocked(prisma.repoCollaborator.delete).mockResolvedValue({} as never);
  });

  it("deletes the ex-collaborator's watch row when they lose read access", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(PRIV_OWNED as never);
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(PRIV_OWNED as never);

    const res = await app.inject({
      method: "DELETE", url: "/repos/priv/collaborators/collab",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.watch.deleteMany).toHaveBeenCalledWith({
      where: { repoId: "repo-owned", userId: "collab-1" },
    });
  });

  it("keeps the watch row on a PUBLIC repo — read access survives the removal", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/repos/pub/collaborators/collab",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.watch.deleteMany).not.toHaveBeenCalled();
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
    expect(res.json()).toEqual({ items: [], perPage: 25, nextCursor: null, hasMore: false });
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
    // The cursor names the last delivered entry: createdAt | item id.
    expect(body.nextCursor).toBe("2026-01-15T09:00:00.000Z|issue-i1");

    // Page 2 carries the remaining release.
    const page2 = await app.inject({
      method: "GET", url: `/feed?per_page=2&cursor=${encodeURIComponent(body.nextCursor)}`,
      headers: { authorization: strangerToken },
    });
    expect(page2.json().items.map((i: { type: string }) => i.type)).toEqual(["release"]);
    expect(page2.json().hasMore).toBe(false);
    expect(page2.json().nextCursor).toBeNull();

    // Every source query is bounded by the cursor, not re-read from the top —
    // and STRICTLY after it, so none of the window is spent re-fetching the
    // cursor row (the id branch covers the cursor's own same-timestamp group).
    const secondIssueQuery = vi.mocked(prisma.issue.findMany).mock.calls[1]![0] as {
      where: { OR?: Array<Record<string, unknown>> }; take: number;
    };
    expect(secondIssueQuery.take).toBe(3);
    expect(secondIssueQuery.where.OR).toEqual([
      { createdAt: { lt: new Date("2026-01-15T09:00:00.000Z") } },
      { createdAt: new Date("2026-01-15T09:00:00.000Z"), id: { gt: "i1" } },
    ]);
  });

  // Regression (adversarial review): offset pagination over a live stream let
  // activity arriving between two page fetches shift every offset, so load-more
  // appended entries the first page had already shown (duplicate React keys).
  it("does not repeat entries when new activity lands between pages", async () => {
    const issueRow = (id: string, at: string, number: number) => ({
      id, repoId: "repo-pub", number, title: `Issue ${id}`,
      createdAt: new Date(at), author: { handle: "alice" },
    });
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      issueRow("a", "2026-01-15T10:00:00Z", 1),
      issueRow("b", "2026-01-15T09:00:00Z", 2),
      issueRow("c", "2026-01-15T08:00:00Z", 3),
    ] as never);

    const page1 = await app.inject({ method: "GET", url: "/feed?per_page=2", headers: { authorization: strangerToken } });
    const first = page1.json();
    expect(first.items.map((i: { id: string }) => i.id)).toEqual(["issue-a", "issue-b"]);

    // …and now a brand-new issue lands at the head of the stream.
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      issueRow("new", "2026-01-15T11:00:00Z", 4),
      issueRow("a", "2026-01-15T10:00:00Z", 1),
      issueRow("b", "2026-01-15T09:00:00Z", 2),
      issueRow("c", "2026-01-15T08:00:00Z", 3),
    ] as never);

    const page2 = await app.inject({
      method: "GET", url: `/feed?per_page=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      headers: { authorization: strangerToken },
    });
    // Offset pagination would have re-served issue-b here.
    expect(page2.json().items.map((i: { id: string }) => i.id)).toEqual(["issue-c"]);
  });

  // A flat mock always hands back every row, so it can never expose a per-source
  // window that is one row too small. This stand-in honours the cursor `where`
  // and `take` the way the real query does, over both the `lt`/`OR` tuple form
  // and the plain `lte` form.
  type IssueRow = { id: string; repoId: string; number: number; title: string; createdAt: Date; author: { handle: string } };
  type Bound = { lt?: Date; lte?: Date };
  type Clause = { createdAt?: Date | Bound; id?: { gt?: string } };

  function honourCursor(rows: IssueRow[]) {
    const matches = (c: Clause, r: IssueRow): boolean => {
      const at = c.createdAt;
      if (at instanceof Date) {
        if (r.createdAt.getTime() !== at.getTime()) return false;
      } else if (at) {
        if (at.lt && r.createdAt.getTime() >= at.lt.getTime()) return false;
        if (at.lte && r.createdAt.getTime() > at.lte.getTime()) return false;
      }
      if (c.id?.gt !== undefined && !(r.id > c.id.gt)) return false;
      return true;
    };
    return (args: { where: Clause & { OR?: Clause[] }; take: number }) => {
      const clauses = args.where.OR ?? [args.where];
      const hits = rows
        .filter((r) => clauses.some((c) => matches(c, r)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return Promise.resolve(hits.slice(0, args.take));
    };
  }

  /** Drain the feed page by page, returning every item id in delivery order. */
  async function walkFeed(perPage: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const url = cursor
        ? `/feed?per_page=${perPage}&cursor=${encodeURIComponent(cursor)}`
        : `/feed?per_page=${perPage}`;
      const res = await app.inject({ method: "GET", url, headers: { authorization: strangerToken } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (!cursor) return seen;
    }
    throw new Error("feed never terminated");
  }

  // Regression (adversarial review): the cursor filtered with `lte` while every
  // source was capped at `perPage + 1`, so the source that produced the cursor
  // re-fetched the cursor row itself and could only ever contribute `perPage`
  // FRESH rows. `hasMore` then evaluated `perPage > perPage` — false — on every
  // deep page, load-more vanished, and the tail of the feed became permanently
  // unreachable. Only a walk to exhaustion catches it; pages 1 and 2 look fine.
  it("walks a multi-page feed to exhaustion, serving every entry exactly once", async () => {
    const rows: IssueRow[] = Array.from({ length: 10 }, (_, n) => ({
      id: `i${n}`, repoId: "repo-pub", number: n + 1, title: `Issue ${n + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, 15, 10, n)),
      author: { handle: "alice" },
    }));
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.issue.findMany).mockImplementation(honourCursor(rows) as never);

    // Newest first, every row exactly once — nothing repeated, nothing stranded.
    expect(await walkFeed(3)).toEqual([...rows].reverse().map((r) => `issue-${r.id}`));
  });

  // Same walk with the whole source sharing one timestamp: the page boundary
  // lands mid-tie, so the id half of the (createdAt, id) comparison is what has
  // to carry pagination forward.
  it("walks a feed whose entries all share one timestamp", async () => {
    const rows: IssueRow[] = Array.from({ length: 7 }, (_, n) => ({
      id: `i${n}`, repoId: "repo-pub", number: n + 1, title: `Issue ${n + 1}`,
      createdAt: NOW, author: { handle: "alice" },
    }));
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.issue.findMany).mockImplementation(honourCursor(rows) as never);

    // Ties break on id ASC, so the delivery order is i0…i6.
    expect(await walkFeed(2)).toEqual(rows.map((r) => `issue-${r.id}`));
  });

  it("ignores a malformed cursor instead of erroring", async () => {
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/feed?cursor=garbage", headers: { authorization: strangerToken } });
    expect(res.statusCode).toBe(200);
    const where = vi.mocked(prisma.issue.findMany).mock.calls[0]![0] as { where: { createdAt?: unknown } };
    expect(where.where.createdAt).toBeUndefined();
  });
});
