import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * Interactive-login session management (issue #117): revocation rejects the
 * token on the next request, "sign out everywhere" spares the current session,
 * and lastSeenAt writes are throttled. Prisma is backed by an in-memory session
 * store so the auth preHandler + session routes exercise the real wiring.
 */

type SessionRow = {
  id: string;
  userId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
};

const store = new Map<string, SessionRow>();
const updateSpy = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
        bio: null,
        location: null,
        website: null,
        emailNotifications: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      })),
    },
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => store.get(id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { userId: string; revokedAt: null } }) =>
        [...store.values()]
          .filter((s) => s.userId === where.userId && s.revokedAt === null)
          .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()),
      ),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<SessionRow> }) => {
        updateSpy(id, data);
        const row = store.get(id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { userId: string; revokedAt: null; id?: { not: string } };
        data: Partial<SessionRow>;
      }) => {
        let count = 0;
        for (const row of store.values()) {
          if (row.userId !== where.userId) continue;
          if (row.revokedAt !== null) continue;
          if (where.id?.not && row.id === where.id.not) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      }),
    },
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("user/repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

import { prisma } from "../prisma.js";
import { createTestServer } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const USER = "user-1";
const OTHER = "user-2";

function seed(row: Partial<SessionRow> & { id: string; userId: string }): SessionRow {
  const full: SessionRow = {
    userAgent: null,
    ip: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    lastSeenAt: new Date("2024-01-01T00:00:00Z"),
    revokedAt: null,
    ...row,
  };
  store.set(full.id, full);
  return full;
}

async function tokenFor(app: FastifyInstance, sub: string, sid?: string) {
  return app.jwt.sign(sid ? { sub, sid } : { sub });
}

let app: FastifyInstance;

beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  store.clear();
  updateSpy.mockClear();
  vi.mocked(prisma.session.update).mockClear();
  vi.mocked(prisma.session.findUnique).mockClear();
  vi.mocked(prisma.session.findMany).mockClear();
  vi.mocked(prisma.session.updateMany).mockClear();
});

// ─── revocation rejects the token ─────────────────────────────────────────────

describe("session revocation on the auth preHandler", () => {
  it("allows a request whose session is active", async () => {
    seed({ id: "s-active", userId: USER });
    const token = await tokenFor(app, USER, "s-active");
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a request whose session was revoked (401 on the next request)", async () => {
    seed({ id: "s-rev", userId: USER });
    const token = await tokenFor(app, USER, "s-rev");
    // First request works…
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // …revoke this device…
    const del = await app.inject({ method: "DELETE", url: "/auth/sessions/s-rev", headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(204);
    // …and the very same token is now rejected.
    const after = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it("still honors a token with no sid (pre-upgrade login) without touching sessions", async () => {
    const token = await tokenFor(app, USER); // no sid
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });
});

// ─── lastSeenAt throttling ────────────────────────────────────────────────────

describe("lastSeenAt stamping is throttled", () => {
  it("stamps lastSeenAt when it is stale (older than the throttle window)", async () => {
    seed({ id: "s-stale", userId: USER, lastSeenAt: new Date(Date.now() - 5 * 60_000) });
    const token = await tokenFor(app, USER, "s-stale");
    await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    // Give the fire-and-forget update a tick to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(updateSpy).toHaveBeenCalledWith("s-stale", expect.objectContaining({ lastSeenAt: expect.any(Date) }));
  });

  it("does NOT stamp lastSeenAt when it was updated within the last minute", async () => {
    seed({ id: "s-fresh", userId: USER, lastSeenAt: new Date(Date.now() - 1_000) });
    const token = await tokenFor(app, USER, "s-fresh");
    await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    await new Promise((r) => setTimeout(r, 5));
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ─── GET /auth/sessions ───────────────────────────────────────────────────────

describe("GET /auth/sessions", () => {
  it("lists active sessions and flags the current one", async () => {
    seed({ id: "s-cur", userId: USER, userAgent: "Firefox", lastSeenAt: new Date("2024-02-02") });
    seed({ id: "s-old", userId: USER, userAgent: "curl", lastSeenAt: new Date("2024-01-01") });
    seed({ id: "s-revoked", userId: USER, revokedAt: new Date() });
    const token = await tokenFor(app, USER, "s-cur");
    const res = await app.inject({ method: "GET", url: "/auth/sessions", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ id: string; current: boolean; userAgent: string | null }> };
    // Revoked session excluded; newest first; current flagged.
    expect(body.sessions.map((s) => s.id)).toEqual(["s-cur", "s-old"]);
    expect(body.sessions.find((s) => s.id === "s-cur")!.current).toBe(true);
    expect(body.sessions.find((s) => s.id === "s-old")!.current).toBe(false);
  });
});

// ─── DELETE /auth/sessions/:id ────────────────────────────────────────────────

describe("DELETE /auth/sessions/:id", () => {
  it("404s when revoking a session belonging to another user", async () => {
    seed({ id: "s-cur", userId: USER });
    seed({ id: "s-theirs", userId: OTHER });
    const token = await tokenFor(app, USER, "s-cur");
    const res = await app.inject({ method: "DELETE", url: "/auth/sessions/s-theirs", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
    expect(store.get("s-theirs")!.revokedAt).toBeNull();
  });
});

// ─── DELETE /auth/sessions (everywhere) ───────────────────────────────────────

describe("DELETE /auth/sessions (sign out everywhere)", () => {
  it("revokes every other active session but spares the current one", async () => {
    seed({ id: "s-cur", userId: USER });
    seed({ id: "s-a", userId: USER });
    seed({ id: "s-b", userId: USER });
    seed({ id: "s-other-user", userId: OTHER });
    const token = await tokenFor(app, USER, "s-cur");
    const res = await app.inject({ method: "DELETE", url: "/auth/sessions", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });
    expect(store.get("s-cur")!.revokedAt).toBeNull();       // current spared
    expect(store.get("s-a")!.revokedAt).not.toBeNull();     // others revoked
    expect(store.get("s-b")!.revokedAt).not.toBeNull();
    expect(store.get("s-other-user")!.revokedAt).toBeNull(); // untouched
    // The current token still works after signing out everywhere.
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });
});
