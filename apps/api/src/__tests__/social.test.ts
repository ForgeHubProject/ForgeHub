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
    // 4 explicit ALL rows, counted by the aggregate…
    vi.mocked(prisma.watch.count).mockResolvedValue(4 as never);
    // …and of the members, only collab-1 has a row — collab-2 and the owner are implicit.
    vi.mocked(prisma.watch.findMany).mockResolvedValue([{ userId: "collab-1" }] as never);

    const res = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: ownerToken },
    });
    expect(res.json().watcherCount).toBe(6);
  });

  // Regression (adversarial review, round 3): the read-access intersection was
  // implemented by pulling EVERY watch row for the repo into Node — no take, no
  // aggregate — on `GET /repos/:h/:n/social`, which every repo page view hits.
  // On a PUBLIC repo (where the watcher set is largest) `canRead` is
  // unconditionally true, so the whole scan bought nothing over the COUNT it
  // replaced. The count must come from an aggregate, and any row read on this
  // path must be bounded by the owner+collaborator set.
  it("GET /social counts a public repo's watchers with an aggregate, never a full row scan", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      ...PUBLIC_REPO, collaborators: [{ userId: "collab-1" }],
    } as never);
    // 20 000 subscribers. A full-scan implementation would have to materialize
    // all of them; the aggregate just reports the number.
    vi.mocked(prisma.watch.count).mockResolvedValue(20_000 as never);
    vi.mocked(prisma.watch.findMany).mockResolvedValue([]);

    const res = await app.inject({
      method: "GET", url: "/repos/alice/pub/social",
      headers: { authorization: strangerToken },
    });
    // 20 000 explicit ALL rows + the row-less owner and collab-1.
    expect(res.json().watcherCount).toBe(20_002);
    expect(prisma.watch.count).toHaveBeenCalledWith({ where: { repoId: "repo-pub", level: "ALL" } });
    // Every row read this path performs is bounded by an explicit id list.
    const rowReads = vi.mocked(prisma.watch.findMany).mock.calls as Array<[{ where: { userId?: { in?: string[] } } }]>;
    expect(rowReads.length).toBeGreaterThan(0);
    for (const [args] of rowReads) {
      expect(args.where.userId?.in).toEqual(["owner-1", "collab-1"]);
    }
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

  // Regression (adversarial review, round 4): the PRIVATE branch still pulled
  // EVERY watch row for the repo into Node — no take, no aggregate — on the
  // repo-page hot path. The round-3 comment excused it with "there the
  // subscriber set is bounded by the grantee set anyway", which is false: a
  // Watch row is a subscription, never a grant, so rows outlive access changes
  // that have no cleanup hook. `PATCH /repos/:name` is the sharpest case — it
  // writes `visibility` and prunes nothing, so a public repo carrying 20 000
  // subscribers keeps all 20 000 rows the instant it goes private, and the
  // count then materialized every one of them to return the number 2.
  // The bound must be imposed by the query, over the grantee set.
  it("GET /social bounds a private repo's watcher read to the grantee set", async () => {
    const GRANTEES = ["owner-1", "collab-1", "org-owner-1", "team-member-1"];
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      ...PRIVATE_REPO,
      ownerId: "owner-1",
      collaborators: [{ userId: "collab-1", role: "READER" }],
      org: { id: "org-1", handle: "acme", memberships: [
        { userId: "org-owner-1", role: "OWNER" },
        { userId: "org-member-1", role: "MEMBER" }, // not a grantee: bare member
      ] },
      teamAccess: [{ role: "READER", team: { memberships: [{ userId: "team-member-1" }] } }],
    } as never);

    // The "database": the four grantees (all with explicit ALL rows) plus the
    // 20 000 subscriptions a visibility flip left behind. The stand-in honours
    // `where.userId.in` the way a real query does, so an unbounded read hands
    // back all 20 004 rows and a bounded one hands back 4.
    const stored = [
      ...GRANTEES.map((userId) => ({ userId, level: "ALL" })),
      ...Array.from({ length: 20_000 }, (_, n) => ({ userId: `stale-${n}`, level: "ALL" })),
    ];
    let materialized = -1;
    vi.mocked(prisma.watch.findMany).mockImplementation((async (args: {
      where: { userId?: { in?: string[] } };
    }) => {
      const bound = args.where.userId?.in;
      const rows = bound ? stored.filter((r) => bound.includes(r.userId)) : stored;
      materialized = rows.length;
      return rows;
    }) as never);

    const res = await app.inject({
      method: "GET", url: "/repos/bob/priv/social",
      headers: { authorization: ownerToken },
    });
    // Unchanged semantics: the four grantees, and not one stale subscriber.
    expect(res.json().watcherCount).toBe(4);
    // …and the route never pulled the stale rows into Node to work that out.
    expect(materialized).toBe(GRANTEES.length);
    const [args] = vi.mocked(prisma.watch.findMany).mock.calls[0]! as [
      { where: { userId?: { in?: string[] } } },
    ];
    expect(args.where.userId?.in).toEqual(GRANTEES);
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
  // window that is one row too small. This stand-in honours the cursor `where`,
  // the `take`, AND — critically — the `orderBy` the way a real database does.
  //
  // A database orders by exactly the keys the query names and NO further: rows
  // that tie on every named key come back in whatever order the storage engine
  // finds them. Confirmed against a real SQLite database — 5 issues sharing one
  // timestamp, physically stored i5,i1,i4,i2,i3, queried with
  // `orderBy: { createdAt: 'desc' }, take: 3`, come back i5,i1,i4: physical
  // order, not id order. So `rows` is treated as PHYSICAL order here, and the
  // id tiebreak is applied only when the query actually asks for `id: 'asc'`.
  // (An earlier revision of this stand-in always sorted ties by id ascending.
  // That handed the route an ordering guarantee production never requested, and
  // made the multi-page walks below pass no matter what `orderBy` the route
  // used — the tests could not fail.)
  type IssueRow = { id: string; repoId: string; number: number; title: string; createdAt: Date; author: { handle: string } };
  type Bound = { lt?: Date; lte?: Date };
  type Clause = { createdAt?: Date | Bound; id?: { gt?: string } };
  type OrderKey = { createdAt?: "asc" | "desc"; id?: "asc" | "desc" };
  /** Everything the stand-in itself looks at — the rest is the source's payload. */
  type SourceRow = { id: string; createdAt: Date };

  function honourCursor<R extends SourceRow>(rows: R[]) {
    const matches = (c: Clause, r: R): boolean => {
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
    return (args: { where: Clause & { OR?: Clause[] }; take: number; orderBy?: OrderKey | OrderKey[] }) => {
      const keys = args.orderBy === undefined ? [] : Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      const cmp = (a: R, b: R): number => {
        for (const k of keys) {
          if (k.createdAt) {
            const d = a.createdAt.getTime() - b.createdAt.getTime();
            if (d !== 0) return k.createdAt === "desc" ? -d : d;
          }
          if (k.id) {
            const d = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            if (d !== 0) return k.id === "desc" ? -d : d;
          }
        }
        // Tied on every key the query named: leave them in physical order.
        // Array#sort is stable, so `rows` order survives.
        return 0;
      };
      const hits = rows.filter((r) => clausesOf(args.where).some((c) => matches(c, r))).sort(cmp);
      return Promise.resolve(hits.slice(0, args.take));
    };
  }
  const clausesOf = (where: Clause & { OR?: Clause[] }): Clause[] => where.OR ?? [where];

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

  /** Point every feed source at one public repo, with `issue` served by `rows`. */
  function feedOverIssues(rows: IssueRow[]) {
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.issue.findMany).mockImplementation(honourCursor(rows) as never);
  }

  // Regression (adversarial review, round 3): every source query ordered by
  // `createdAt` DESC alone while the cursor advanced with `id: { gt: … }`. A
  // database asked for that ordering is free to return a same-timestamp group in
  // any order — SQLite returns physical order — so `take: perPage + 1` sliced an
  // ARBITRARY subset out of the tie group, and the cursor then excluded every
  // tied row whose id sorted at-or-below the one served last, INCLUDING rows the
  // window never returned. Those rows were unreachable on every subsequent page.
  //
  // The physical order below (i5,i1,i4,i2,i3) is the one observed on a real
  // SQLite database. Before the fix this walk served i1, i4, i5 and stranded i2
  // and i3 forever.
  it("walks a feed whose entries all share one timestamp, whatever order the rows arrive in", async () => {
    const physical = ["i5", "i1", "i4", "i2", "i3"];
    const rows: IssueRow[] = physical.map((id, n) => ({
      id, repoId: "repo-pub", number: n + 1, title: `Issue ${id}`,
      createdAt: NOW, author: { handle: "alice" },
    }));
    feedOverIssues(rows);

    // The whole group ties on createdAt, so the id tiebreak the query now asks
    // for is the only thing carrying pagination forward: every row exactly once,
    // in id order — not merely the ones the first window happened to catch.
    expect(await walkFeed(2)).toEqual(["i1", "i2", "i3", "i4", "i5"].map((id) => `issue-${id}`));
  });

  // The same defect with the tie at the TAIL of a mostly-distinct stream, which
  // is what it looks like in production: 24 distinct timestamps then 3 rows
  // sharing one instant, at a per_page that puts the page boundary inside the
  // tie. Before the fix this served 26 of the 27 entries — `t1` was lost forever
  // because the window took `t2`,`t3` and the cursor then advanced past `t2`.
  it("does not strand a tied entry when a page boundary lands inside a tail tie", async () => {
    const distinct: IssueRow[] = Array.from({ length: 24 }, (_, n) => ({
      id: `d${String(n).padStart(2, "0")}`, repoId: "repo-pub", number: n + 1, title: `Issue d${n}`,
      createdAt: new Date(Date.UTC(2026, 0, 15, 10, 30 - n)), author: { handle: "alice" },
    }));
    const tailAt = new Date(Date.UTC(2026, 0, 15, 10, 5));
    // Physical order inside the tie group is t2, t3, t1 — the id that sorts
    // FIRST is the one the window would have missed.
    const tail: IssueRow[] = ["t2", "t3", "t1"].map((id, n) => ({
      id, repoId: "repo-pub", number: 100 + n, title: `Issue ${id}`,
      createdAt: tailAt, author: { handle: "alice" },
    }));
    feedOverIssues([...distinct, ...tail]);

    const served = await walkFeed(25);
    expect(served).toHaveLength(27);
    expect(new Set(served).size).toBe(27);
    expect(served).toEqual([
      ...distinct.map((r) => `issue-${r.id}`),
      "issue-t1", "issue-t2", "issue-t3",
    ]);
  });

  // Regression (adversarial review, round 4): both tie walks above run through
  // `feedOverIssues`, which mocks the ISSUE source and hard-codes the other
  // three to []. So they pin the id tiebreak on ONE of the four source queries —
  // `pullRequest`, `release` and `timelineEvent` could each carry the identical
  // data-loss defect with the whole suite green. Each source gets the same walk:
  // one repo, five entries sharing a single timestamp, stored in the scrambled
  // physical order observed on a real SQLite database, drained at per_page=2.
  // Drop `{ id: "asc" }` from that source's `orderBy` and its window slices an
  // arbitrary subset out of the tie group while the cursor advances past the
  // rest — exactly the loss the issue-source walk already pins.
  const TIE_PHYSICAL = ["s5", "s1", "s4", "s2", "s3"];

  /** Point every feed source at one public repo, with `source` served by `ids`. */
  function feedOverSource(source: "pr" | "release" | "event", ids: string[]) {
    vi.mocked(prisma.star.findMany).mockResolvedValue([{ repoId: "repo-pub" }] as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ ...PUBLIC_REPO, owner: { handle: "alice" } }] as never);
    // Also covers the timeline subject-title lookup, which reads issue/pr again.
    vi.mocked(prisma.issue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([]);

    const base = ids.map((id, n) => ({ id, repoId: "repo-pub", number: n + 1, createdAt: NOW }));
    const author = { handle: "alice" };
    if (source === "pr") {
      vi.mocked(prisma.pullRequest.findMany).mockImplementation(
        honourCursor(base.map((r) => ({ ...r, title: `PR ${r.id}`, author }))) as never,
      );
    } else if (source === "release") {
      vi.mocked(prisma.release.findMany).mockImplementation(
        honourCursor(base.map((r) => ({ ...r, tagName: `v${r.number}`, name: `Release ${r.id}`, author }))) as never,
      );
    } else {
      vi.mocked(prisma.timelineEvent.findMany).mockImplementation(
        honourCursor(
          base.map((r) => ({
            ...r, kind: "closed", subjectType: "ISSUE", subjectNumber: r.number,
            data: JSON.stringify({ actorHandle: "alice" }),
          })),
        ) as never,
      );
    }
  }

  it.each(["pr", "release", "event"] as const)(
    "walks a %s-source tie group to exhaustion without stranding an entry",
    async (source) => {
      feedOverSource(source, TIE_PHYSICAL);
      expect(await walkFeed(2)).toEqual(
        ["s1", "s2", "s3", "s4", "s5"].map((id) => `${source}-${id}`),
      );
    },
  );

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
