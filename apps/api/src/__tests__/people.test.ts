/**
 * Profiles (#257): the new profile fields and status, pinned repositories,
 * and following.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    repo: { findMany: vi.fn() },
    profilePin: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    follow: { count: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    block: { findUnique: vi.fn().mockResolvedValue(null) },
    orgMembership: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ME = "user-me";
const ADA = { id: "user-ada", handle: "ada", email: "ada@x.io", displayName: "Ada", bio: null, location: null, website: null,
  createdAt: new Date("2026-01-01"), emailNotifications: false, avatarKey: null };
const repo = (id: string, visibility: "PUBLIC" | "PRIVATE") => ({
  id, name: id, description: null, visibility, storageKey: null, ownerId: "someone", createdAt: new Date(), updatedAt: new Date(),
  owner: { handle: "acme" }, org: null, collaborators: [], teamAccess: [], topics: [], _count: { stars: 0 },
});

let app: FastifyInstance;
let token: string;
beforeAll(async () => {
  app = await createTestServer();
  token = await authHeader(app, ME);
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(ADA as never);
});

const call = (method: "GET" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: token }, payload });

describe("profile fields", () => {
  it("shows pronouns, company, links and a live status, with follow counts", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...ADA, pronouns: "she/her", company: "Analytical", socialLinks: JSON.stringify(["https://example.com/ada"]),
      statusEmoji: "🧮", statusText: "Computing", statusExpiresAt: null,
    } as never);
    vi.mocked(prisma.follow.count).mockResolvedValueOnce(3 as never).mockResolvedValueOnce(1 as never);
    vi.mocked(prisma.follow.findUnique).mockResolvedValue({ followerId: ME } as never);
    const res = await call("GET", "/users/ada");
    expect(res.json()).toMatchObject({
      pronouns: "she/her", company: "Analytical", socialLinks: ["https://example.com/ada"],
      status: { emoji: "🧮", text: "Computing" }, followers: 3, following: 1, viewerFollows: true,
    });
  });

  it("hides an expired status", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...ADA, statusText: "Away", statusExpiresAt: new Date("2020-01-01") } as never);
    vi.mocked(prisma.follow.count).mockResolvedValue(0 as never);
    expect((await call("GET", "/users/ada")).json().status).toBeNull();
  });

  it("saves the fields, and refuses links that aren't http(s) or are too many", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({ ...ADA, id: ME } as never);
    const ok = await call("PATCH", "/users/me", { pronouns: " they/them ", socialLinks: ["https://a.io", ""], status: { emoji: "🌱", text: "Gardening" } });
    expect(ok.statusCode).toBe(200);
    expect(vi.mocked(prisma.user.update).mock.calls[0][0]).toMatchObject({
      data: { pronouns: "they/them", socialLinks: JSON.stringify(["https://a.io"]), statusEmoji: "🌱", statusText: "Gardening" },
    });
    expect((await call("PATCH", "/users/me", { socialLinks: ["javascript:alert(1)"] })).statusCode).toBe(400);
    expect((await call("PATCH", "/users/me", { socialLinks: ["https://1.io", "https://2.io", "https://3.io", "https://4.io", "https://5.io"] })).statusCode).toBe(400);
  });
});

describe("pins", () => {
  it("shows only the pins the viewer can read, in order", async () => {
    vi.mocked(prisma.profilePin.findMany).mockResolvedValue([
      { repo: repo("open", "PUBLIC") }, { repo: repo("secret", "PRIVATE") },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/users/ada/pins" });
    expect(res.json().repos.map((r: { name: string }) => r.name)).toEqual(["open"]);
  });

  it("replaces the caller's pins, up to six readable repositories", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([repo("a", "PUBLIC"), repo("b", "PUBLIC")] as never);
    const res = await call("PUT", "/users/me/pins", { repoIds: ["b", "a"] });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.profilePin.create).mock.calls.map((c) => c[0].data)).toEqual([
      { userId: ME, repoId: "b", position: 0 }, { userId: ME, repoId: "a", position: 1 },
    ]);
    expect((await call("PUT", "/users/me/pins", { repoIds: ["1", "2", "3", "4", "5", "6", "7"] })).statusCode).toBe(400);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([repo("s", "PRIVATE")] as never);
    expect((await call("PUT", "/users/me/pins", { repoIds: ["s"] })).statusCode).toBe(404);
  });
});

describe("following", () => {
  it("follows and unfollows, but not yourself", async () => {
    vi.mocked(prisma.follow.count).mockResolvedValue(1 as never);
    const res = await call("PUT", "/users/ada/follow");
    expect(res.json()).toEqual({ following: true, followers: 1 });
    expect(vi.mocked(prisma.follow.upsert).mock.calls[0][0]).toMatchObject({ create: { followerId: ME, followingId: "user-ada" } });
    expect((await call("DELETE", "/users/ada/follow")).json().following).toBe(false);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...ADA, id: ME } as never);
    expect((await call("PUT", "/users/me-handle/follow")).statusCode).toBe(400);
  });

  it("lists followers", async () => {
    vi.mocked(prisma.follow.findMany).mockResolvedValue([{ follower: { handle: "bob", displayName: null, avatarKey: null, bio: null } }] as never);
    const res = await app.inject({ method: "GET", url: "/users/ada/followers" });
    expect(res.json().users).toEqual([{ handle: "bob", displayName: null, avatarKey: null, bio: null }]);
  });
});
