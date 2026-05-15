import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    repo: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    repoCollaborator: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    pullRequest: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/my-repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/alice/my-repo.git"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn().mockResolvedValue({
    storageKey: "alice/my-repo.git",
    absolutePath: "/tmp/alice/my-repo.git",
    exists: true,
    isBare: true,
  }),
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
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  cloneMirror: vi.fn(),
  git: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$hashed$"),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-owner";
const COLLAB_ID = "user-collab";

const mockOwner = { id: OWNER_ID, handle: "alice", email: "alice@example.com", displayName: "Alice", createdAt: new Date(), updatedAt: new Date(), passwordHash: "$h$" };
const mockCollab = { id: COLLAB_ID, handle: "bob", email: "bob@example.com", displayName: "Bob", createdAt: new Date(), updatedAt: new Date(), passwordHash: "$h$" };

function makeRepo(overrides = {}) {
  return {
    id: "repo-1",
    name: "my-repo",
    description: null,
    visibility: "PRIVATE" as const,
    storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: { handle: "alice" },
    collaborators: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /repos", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockOwner as never);
    vi.mocked(prisma.repo.create).mockResolvedValue(makeRepo() as never);
  });

  it("201 with created repo for valid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: token },
      payload: { name: "my-repo", visibility: "private" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("my-repo");
    expect(body.visibility).toBe("private");
  });

  it("401 without authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/repos", payload: { name: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("400 for invalid repo name (spaces)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: token },
      payload: { name: "bad name" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when repo name already exists (P2002)", async () => {
    vi.mocked(prisma.repo.create).mockRejectedValueOnce({ code: "P2002" });
    const res = await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: token },
      payload: { name: "my-repo" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("repo name is stored lowercased", async () => {
    await app.inject({
      method: "POST",
      url: "/repos",
      headers: { authorization: token },
      payload: { name: "MyRepo" },
    });
    const calls = vi.mocked(prisma.repo.create).mock.calls;
    const lastCall = calls[calls.length - 1]![0];
    expect(lastCall.data.name).toBe("myrepo");
  });
});

describe("GET /repos/mine", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  it("200 with array of repos", async () => {
    vi.mocked(prisma.repo.findMany).mockResolvedValue([makeRepo()] as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/mine",
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
  });

  it("401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/mine" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /repos/:handle/:name", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  it("200 for a public repo without auth", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PUBLIC" }) as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("my-repo");
  });

  it("200 for a private repo when the owner requests it", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it("404 for a private repo when unauthenticated", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo" });
    expect(res.statusCode).toBe(404);
  });

  it("404 for a private repo when accessed by a non-collaborator", async () => {
    const strangerToken = await authHeader(app, "stranger-id");
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ visibility: "PRIVATE", collaborators: [] }) as never,
    );
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo",
      headers: { authorization: strangerToken },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404 when repo does not exist", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /repos/:name", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.repo.update).mockResolvedValue(makeRepo({ description: "new desc" }) as never);
    vi.mocked(prisma.repo.findFirstOrThrow).mockResolvedValue(makeRepo() as never);
  });

  it("200 when updating description", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/my-repo",
      headers: { authorization: token },
      payload: { description: "new desc" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400 for invalid visibility value", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/my-repo",
      headers: { authorization: token },
      payload: { visibility: "protected" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 when repo not owned by caller", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/not-mine",
      headers: { authorization: token },
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 without authentication", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/my-repo",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /repos/:name", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.repo.delete).mockResolvedValue(makeRepo() as never);
  });

  it("204 for owned repo", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/my-repo",
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(204);
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/other-repo",
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 without token", async () => {
    const res = await app.inject({ method: "DELETE", url: "/repos/my-repo" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /repos/:name/collaborators", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCollab as never);
    vi.mocked(prisma.repoCollaborator.upsert).mockResolvedValue({
      id: "collab-1",
      repoId: "repo-1",
      userId: COLLAB_ID,
      role: "READER",
      createdAt: new Date(),
      user: { id: COLLAB_ID, handle: "bob", email: "bob@example.com", displayName: null },
    } as never);
  });

  it("201 when adding a new collaborator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/my-repo/collaborators",
      headers: { authorization: token },
      payload: { handle: "bob", role: "reader" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("reader");
  });

  it("400 when trying to add the owner as collaborator", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockOwner as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/my-repo/collaborators",
      headers: { authorization: token },
      payload: { handle: "alice" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/owner/i);
  });

  it("404 when collaborator user not found", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/repos/my-repo/collaborators",
      headers: { authorization: token },
      payload: { handle: "nobody" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /repos/:name/collaborators/:handle", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCollab as never);
    vi.mocked(prisma.repoCollaborator.findUnique).mockResolvedValue({ id: "c1" } as never);
    vi.mocked(prisma.repoCollaborator.delete).mockResolvedValue({ id: "c1" } as never);
  });

  it("204 on success", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/my-repo/collaborators/bob",
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(204);
  });

  it("404 when collaborator entry does not exist", async () => {
    vi.mocked(prisma.repoCollaborator.findUnique).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/my-repo/collaborators/bob",
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(404);
  });
});
