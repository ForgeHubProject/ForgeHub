import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    personalAccessToken: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$hashed$"), compare: vi.fn() },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("user/repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn(),
  defaultBranch: vi.fn(),
  resolveBranchSha: vi.fn(),
  performMerge: vi.fn(),
  performMergeWithResolvedFiles: vi.fn(),
  branchShas: vi.fn(),
  listFilesDifferingBetweenBranches: vi.fn(),
  readFileAtBranch: vi.fn(),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  cloneMirror: vi.fn(),
  git: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const USER_ID = "user-abc";

describe("POST /auth/tokens", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  it("401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/tokens", payload: { name: "ci" } });
    expect(res.statusCode).toBe(401);
  });

  it("400 for missing name", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("201 returns plaintext token once, hashed value stored, not returned", async () => {
    vi.mocked(prisma.personalAccessToken.create).mockImplementation((async ({ data }: any) => ({
      id: "tok-1", userId: data.userId, name: data.name, tokenHash: data.tokenHash,
      tokenPrefix: data.tokenPrefix, expiresAt: data.expiresAt, lastUsedAt: null, createdAt: new Date("2026-01-01"),
    })) as never);

    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { name: "ci" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^fhp_/);
    expect(body.name).toBe("ci");
    expect(body.tokenHash).toBeUndefined();

    const createCall = vi.mocked(prisma.personalAccessToken.create).mock.calls[0]![0] as any;
    expect(createCall.data.userId).toBe(USER_ID);
    expect(createCall.data.tokenHash).not.toBe(body.token);
  });

  it("sets expiresAt when expiresInDays given", async () => {
    vi.mocked(prisma.personalAccessToken.create).mockImplementation((async ({ data }: any) => ({
      id: "tok-2", ...data, lastUsedAt: null, createdAt: new Date(),
    })) as never);
    const res = await app.inject({
      method: "POST", url: "/auth/tokens",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { name: "ci", expiresInDays: 30 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expiresAt).toBeTruthy();
  });
});

describe("GET /auth/tokens", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  it("lists tokens without hash", async () => {
    vi.mocked(prisma.personalAccessToken.findMany).mockResolvedValue([
      {
        id: "tok-1", userId: USER_ID, name: "ci", tokenHash: "abc123", tokenPrefix: "fhp_abcdef",
        expiresAt: null, lastUsedAt: null, createdAt: new Date("2026-01-01"),
      },
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/auth/tokens",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].prefix).toBe("fhp_abcdef");
    expect(body.tokens[0].tokenHash).toBeUndefined();
  });
});

describe("DELETE /auth/tokens/:id", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => { vi.clearAllMocks(); });

  it("204 and deletes when caller owns the token", async () => {
    vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue({
      id: "tok-1", userId: USER_ID, name: "ci", tokenHash: "h", tokenPrefix: "fhp_abc",
      expiresAt: null, lastUsedAt: null, createdAt: new Date(),
    } as never);

    const res = await app.inject({
      method: "DELETE", url: "/auth/tokens/tok-1",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.personalAccessToken.delete)).toHaveBeenCalledWith({ where: { id: "tok-1" } });
  });

  it("404 when token belongs to another user", async () => {
    vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue({
      id: "tok-1", userId: "someone-else", name: "ci", tokenHash: "h", tokenPrefix: "fhp_abc",
      expiresAt: null, lastUsedAt: null, createdAt: new Date(),
    } as never);

    const res = await app.inject({
      method: "DELETE", url: "/auth/tokens/tok-1",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404 when token does not exist", async () => {
    vi.mocked(prisma.personalAccessToken.findUnique).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE", url: "/auth/tokens/nope",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(404);
  });
});
