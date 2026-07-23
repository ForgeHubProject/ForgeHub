import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { hashToken } from "../tokens.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER = "owner-1";
const READ_TOKEN = "fhp_readonly";
const WRITE_TOKEN = "fhp_write";
const ADMIN_TOKEN = "fhp_admin";

/** Route a PAT lookup by the presented token's hash to a scope string. */
function wirePats(byHash: Record<string, { userId: string; scopes: string } | null>) {
  vi.mocked(prisma.personalAccessToken.findUnique).mockImplementation(((args: { where: { tokenHash: string } }) => {
    const rec = byHash[args.where.tokenHash] ?? null;
    return Promise.resolve(rec ? { id: "pat", userId: rec.userId, scopes: rec.scopes, expiresAt: null } : null);
  }) as never);
  vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);
}

let app: FastifyInstance;
beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); });

// ─── git push write path: PAT must carry repo:write ───────────────────────────

describe("git-http write path requires the repo:write scope", () => {
  function basic(user: string, pass: string) {
    return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      id: "repo-1", ownerId: OWNER, visibility: "PUBLIC", storageKey: "owner/widget.git", collaborators: [],
    } as never);
  });

  it("403s a repo:read PAT trying git-receive-pack (a write op)", async () => {
    wirePats({ [hashToken(READ_TOKEN)]: { userId: OWNER, scopes: "repo:read" } });
    const res = await app.inject({
      method: "GET",
      url: "/git/owner/widget.git/info/refs?service=git-receive-pack",
      headers: { authorization: basic("owner", READ_TOKEN) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
  });
});

// ─── settings/token routes require admin ──────────────────────────────────────

describe("token routes require the admin scope", () => {
  it("403s a repo:write PAT creating a token", async () => {
    wirePats({ [hashToken(WRITE_TOKEN)]: { userId: OWNER, scopes: "repo:read,repo:write" } });
    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      payload: { name: "ci" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("admin");
  });

  it("lets an admin PAT create a scoped token", async () => {
    wirePats({ [hashToken(ADMIN_TOKEN)]: { userId: OWNER, scopes: "admin" } });
    vi.mocked(prisma.personalAccessToken.create).mockImplementation(((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "new-tok", lastUsedAt: null, createdAt: new Date(), ...args.data })) as never);
    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "deploy", scopes: ["repo:read"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^fhp_/);
    expect(body.scopes).toEqual(["repo:read"]);
    // stored scopes reflect the requested subset
    const created = vi.mocked(prisma.personalAccessToken.create).mock.calls[0]![0] as { data: { scopes: string } };
    expect(created.data.scopes).toBe("repo:read");
  });

  it("still lets a session JWT (unscoped) manage tokens", async () => {
    vi.mocked(prisma.personalAccessToken.create).mockImplementation(((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "t", lastUsedAt: null, createdAt: new Date(), ...args.data })) as never);
    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { name: "laptop" },
    });
    expect(res.statusCode).toBe(201);
    // default full scope set when none requested
    expect(res.json().scopes).toEqual(["repo:read", "repo:write", "admin"]);
  });
});
