import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
    webhook: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhookDelivery: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER = "owner-1";
const OTHER = "other-2";

/** A public repo owned by OWNER (resolveRepo → findFirst). */
function ownerRepo(overrides: Record<string, unknown> = {}) {
  return { id: "repo-1", name: "widget", ownerId: OWNER, visibility: "PUBLIC", storageKey: "owner/widget.git", collaborators: [], ...overrides };
}

let app: FastifyInstance;
beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  // A created hook never uses a real endpoint in tests: 127.0.0.1 makes the
  // fire-and-forget ping fail the SSRF guard (no network), keeping tests hermetic.
  vi.mocked(prisma.webhook.create).mockImplementation(((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "hook-1", createdAt: new Date(), updatedAt: new Date(), ...args.data })) as never);
  vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ id: "hook-1", repoId: "repo-1", url: "http://127.0.0.1:9/x", secret: "s", events: "*", active: true } as never);
  vi.mocked(prisma.webhookDelivery.create).mockResolvedValue({ id: "d1", createdAt: new Date() } as never);
  vi.mocked(prisma.repo.findUnique).mockResolvedValue({ name: "widget", owner: { handle: "owner" } } as never);
  vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never); // lastUsedAt bump (fire-and-forget)
});

describe("owner-only webhook CRUD", () => {
  it("401 for a guest", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/hooks" });
    expect(res.statusCode).toBe(401);
  });

  it("owner creates a hook (201, secret never returned)", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { url: "http://127.0.0.1:9/x", secret: "shhh", events: ["push", "issues"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe("hook-1");
    expect(body.events).toEqual(["push", "issues"]);
    expect(body.active).toBe(true);
    expect(body.secret).toBeUndefined();
    // events persisted as a comma list
    const created = vi.mocked(prisma.webhook.create).mock.calls[0]![0] as { data: { events: string } };
    expect(created.data.events).toBe("push,issues");
  });

  it("defaults to all events ('*') when none are given", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { url: "http://127.0.0.1:9/x", secret: "shhh" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().events).toEqual(["*"]);
  });

  it("400 on an invalid URL", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { url: "not a url", secret: "shhh" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403 for a non-owner on a public repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OTHER) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 for a non-owner on a PRIVATE repo (existence hidden)", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OTHER) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists hooks without secrets", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: "hook-1", url: "https://ex.com/h", secret: "topsecret", events: "push", active: true, createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hooks).toHaveLength(1);
    expect(body.hooks[0].events).toEqual(["push"]);
    expect(JSON.stringify(body)).not.toContain("topsecret");
  });

  it("toggles active via PATCH", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhook.findFirst).mockResolvedValue({ id: "hook-1", repoId: "repo-1" } as never);
    vi.mocked(prisma.webhook.update).mockResolvedValue({ id: "hook-1", url: "https://ex.com/h", secret: "s", events: "*", active: false, createdAt: new Date(), updatedAt: new Date() } as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/owner/widget/hooks/hook-1",
      headers: { authorization: await authHeader(app, OWNER) },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
  });

  it("deletes a hook (204) and 404s an unknown one", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({ id: "hook-1", repoId: "repo-1" } as never);
    vi.mocked(prisma.webhook.delete).mockResolvedValue({} as never);
    const ok = await app.inject({
      method: "DELETE", url: "/repos/owner/widget/hooks/hook-1",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(ok.statusCode).toBe(204);

    vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce(null as never);
    const missing = await app.inject({
      method: "DELETE", url: "/repos/owner/widget/hooks/nope",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("deliveries log + redeliver", () => {
  it("returns recent deliveries for a hook", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhook.findFirst).mockResolvedValue({ id: "hook-1", repoId: "repo-1" } as never);
    vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValue([
      { id: "d1", event: "push", statusCode: 200, ok: true, durationMs: 12, error: null, redeliveredFromId: null, createdAt: new Date() },
      { id: "d2", event: "push", statusCode: 500, ok: false, durationMs: 30, error: "HTTP 500", redeliveredFromId: null, createdAt: new Date() },
    ] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks/hook-1/deliveries",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(200);
    const { deliveries } = res.json();
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ id: "d1", ok: true, statusCode: 200 });
  });

  it("redelivers a past delivery (new attempt recorded)", async () => {
    process.env["ALLOW_PRIVATE_WEBHOOKS"] = "1";
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhookDelivery.findFirst).mockResolvedValue({ id: "d1", webhookId: "hook-1" } as never);
    vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValue({
      id: "d1", webhookId: "hook-1", event: "push", payload: '{"event":"push"}',
      webhook: { id: "hook-1", url: "http://127.0.0.1:9/x", secret: "s" },
    } as never);
    vi.mocked(prisma.webhookDelivery.create).mockResolvedValue({
      id: "d3", event: "push", statusCode: null, ok: false, durationMs: 0, error: "SSRF guard: blocked address 127.0.0.1", redeliveredFromId: "d1", createdAt: new Date(),
    } as never);
    const res = await app.inject({
      method: "POST", url: "/repos/owner/widget/hooks/hook-1/deliveries/d1/redeliver",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().redeliveredFromId).toBe("d1");
    delete process.env["ALLOW_PRIVATE_WEBHOOKS"];
  });
});

describe("PAT scope gating on webhook (admin) routes", () => {
  const READ_TOKEN = "fhp_readonly_token";
  const ADMIN_TOKEN = "fhp_admin_token";

  it("403s a repo:read PAT (admin scope required)", async () => {
    vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue({ id: "p1", userId: OWNER, scopes: "repo:read", expiresAt: null } as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("admin");
  });

  it("allows an admin PAT (owner) to list hooks", async () => {
    vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue({ id: "p2", userId: OWNER, scopes: "admin", expiresAt: null } as never);
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(ownerRepo() as never);
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/owner/widget/hooks",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hooks).toEqual([]);
  });
});
