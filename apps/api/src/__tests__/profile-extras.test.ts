/**
 * More profile (#257): organizations you chose to show, your email when you
 * chose to show it, and your local time.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    follow: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
    block: { findUnique: vi.fn().mockResolvedValue(null) },
    organization: { findUnique: vi.fn() },
    orgMembership: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ME = "user-me";
const ADA = {
  id: "ada", handle: "ada", email: "ada@x.io", displayName: "Ada", bio: null, location: null, website: null, avatarKey: null,
  emailNotifications: false, createdAt: new Date("2026-01-01"), privateProfile: false, showEmail: false, timezone: "Europe/Istanbul",
};

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
  vi.mocked(prisma.orgMembership.findMany).mockResolvedValue([{ org: { handle: "acme", displayName: "Acme" } }] as never);
});

const call = (method: "GET" | "PATCH" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: token }, payload });

describe("profile", () => {
  it("shows public organizations and the time zone, and the email only when chosen", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(ADA as never);
    const res = (await call("GET", "/users/ada")).json();
    expect(res).toMatchObject({ organizations: [{ handle: "acme" }], timezone: "Europe/Istanbul", email: null });
    expect(vi.mocked(prisma.orgMembership.findMany).mock.calls[0][0]!.where).toEqual({ userId: "ada", public: true });

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...ADA, showEmail: true } as never);
    expect((await call("GET", "/users/ada")).json().email).toBe("ada@x.io");
  });

  it("hides organizations on a private profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...ADA, privateProfile: true } as never);
    expect((await call("GET", "/users/ada")).json().organizations).toEqual([]);
    expect(prisma.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it("saves the email choice and a real time zone, and refuses a made-up one", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({ ...ADA, id: ME } as never);
    expect((await call("PATCH", "/users/me", { showEmail: true, timezone: "America/Sao_Paulo" })).statusCode).toBe(200);
    expect(vi.mocked(prisma.user.update).mock.calls[0][0].data).toMatchObject({ showEmail: true, timezone: "America/Sao_Paulo" });
    expect((await call("PATCH", "/users/me", { timezone: "Mars/Olympus" })).statusCode).toBe(400);
  });
});

describe("membership visibility", () => {
  it("changes only the caller's own membership", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1" } as never);
    vi.mocked(prisma.orgMembership.updateMany).mockResolvedValue({ count: 1 });
    expect((await call("PUT", "/orgs/acme/membership/visibility", { public: true })).json()).toEqual({ public: true });
    expect(vi.mocked(prisma.orgMembership.updateMany).mock.calls[0][0]).toEqual({ where: { orgId: "org-1", userId: ME }, data: { public: true } });
    vi.mocked(prisma.orgMembership.updateMany).mockResolvedValue({ count: 0 });
    expect((await call("PUT", "/orgs/acme/membership/visibility", { public: true })).statusCode).toBe(404);
    expect((await call("PUT", "/orgs/acme/membership/visibility", { public: "yes" })).statusCode).toBe(400);
  });
});
