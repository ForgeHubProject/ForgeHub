import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    // Login/register record a Session (issue #117); return a stable id so the
    // handler can embed it in the JWT's `sid` claim.
    session: {
      create: vi.fn().mockResolvedValue({ id: "sess-test" }),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // Register consults the org table to enforce the shared handle space (issue
    // #114); default to "no clash" so existing registration cases are unaffected.
    organization: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$hashed$"),
    compare: vi.fn(),
  },
}));

// git-storage is imported transitively; mock it to avoid real fs calls
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
import bcrypt from "bcryptjs";
import { createTestServer } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockUser = {
  id: "user-abc",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  passwordHash: "$hashed$",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /auth/register", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.user.create).mockResolvedValue(mockUser as never);
  });

  it("201 with user and token for valid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "hunter12", handle: "alice" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.handle).toBe("alice");
    expect(body.token).toBeTruthy();
    expect(body.user.passwordHash).toBeUndefined();
  });

  it("400 for missing email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { password: "hunter12", handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for invalid email format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "not-valid", password: "hunter12", handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for password shorter than 8 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "short", handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for invalid handle (leading hyphen)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "hunter12", handle: "-bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when email or handle is already taken (P2002)", async () => {
    vi.mocked(prisma.user.create).mockRejectedValueOnce({ code: "P2002" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "hunter12", handle: "alice" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already taken/i);
  });

  // Shared handle space (issue #114), collision direction 2: a handle already
  // owned by an ORG cannot be registered as a user handle.
  it("409 when the handle is already taken by an org", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ id: "org-1", handle: "acme" } as never);
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "x@example.com", password: "hunter12", handle: "acme" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already taken/i);
  });

  it("hashes password before storing", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "hunter12", handle: "alice" },
    });
    expect(vi.mocked(bcrypt.hash)).toHaveBeenCalledWith("hunter12", 12);
  });

  it("email is normalised to lowercase", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "ALICE@EXAMPLE.COM", password: "hunter12", handle: "alice" },
    });
    const createCall = vi.mocked(prisma.user.create).mock.calls[0]![0];
    expect(createCall.data.email).toBe("alice@example.com");
  });
});

describe("POST /auth/login", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
  });

  it("200 with token for valid credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@example.com", password: "hunter12" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.handle).toBe("alice");
  });

  it("401 when user not found", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "hunter12" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("401 when password does not match", async () => {
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@example.com", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 for missing password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("email lookup is case-insensitive", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "ALICE@EXAMPLE.COM", password: "hunter12" },
    });
    expect(vi.mocked(prisma.user.findUnique)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "alice@example.com" } }),
    );
  });

  it("response does not include passwordHash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@example.com", password: "hunter12" },
    });
    expect(res.json().user.passwordHash).toBeUndefined();
  });
});

describe("GET /auth/me", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue(mockUser as never);
  });

  it("200 with user for valid JWT", async () => {
    const token = await app.jwt.sign({ sub: mockUser.id });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(mockUser.id);
  });

  it("401 without authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("401 with malformed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("response does not expose passwordHash", async () => {
    const token = await app.jwt.sign({ sub: mockUser.id });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().user.passwordHash).toBeUndefined();
  });
});
