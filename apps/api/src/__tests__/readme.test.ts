import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repo: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    repoCollaborator: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    release: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
    pullRequest: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    snapshot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn() },
    issue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    issueComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    issueLabel: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    label: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReview: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReviewComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    entity: { findMany: vi.fn().mockResolvedValue([]) },
    constraint: { findMany: vi.fn().mockResolvedValue([]) },
    tag: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/my-repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn().mockResolvedValue(true),
  defaultBranch: vi.fn().mockResolvedValue("main"),
  resolveBranchSha: vi.fn().mockResolvedValue("abc1234"),
  performMerge: vi.fn(),
  performMergeWithResolvedFiles: vi.fn(),
  branchShas: vi.fn().mockResolvedValue([]),
  listFilesDifferingBetweenBranches: vi.fn().mockResolvedValue([]),
  readFileAtBranch: vi.fn().mockResolvedValue("# Hello"),
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  tagExists: vi.fn().mockResolvedValue(true),
  cloneMirror: vi.fn(),
  git: vi.fn(),
  listCommits: vi.fn().mockResolvedValue([]),
  getCommit: vi.fn().mockResolvedValue(null),
  listTree: vi.fn().mockResolvedValue([]),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { listTree, readFileAtBranch } from "../git-utils.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function treeEntry(name: string, dirPath = "") {
  const path = dirPath ? `${dirPath}/${name}` : name;
  return { mode: "100644", type: "blob", sha: "abc123", path, name };
}

const MOCK_REPO = {
  id: "repo-1", name: "my-repo", ownerId: "user-1",
  visibility: "PUBLIC", storageKey: "alice/my-repo.git", collaborators: [],
};
const MOCK_PRIVATE_REPO = { ...MOCK_REPO, visibility: "PRIVATE" };

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(readFileAtBranch).mockResolvedValue("# Hello World");
});

// ─── Priority and detection ───────────────────────────────────────────────────

describe("README detection priority", () => {
  it("picks README.md at root by default", async () => {
    vi.mocked(listTree).mockResolvedValue([
      treeEntry("src", ""), // tree entry, should be ignored
      treeEntry("README.md"),
      treeEntry("LICENSE"),
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("README.md");
    expect(body.path).toBe("README.md");
    expect(body.content).toBe("# Hello World");
  });

  it("falls back to README.txt when no .md present", async () => {
    vi.mocked(listTree).mockResolvedValue([
      treeEntry("README.txt"),
      treeEntry("main.ts"),
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("README.txt");
  });

  it("falls back to bare README when no extension present", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("README")] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("README");
  });

  it("prefers README.md over README.txt when both are present", async () => {
    vi.mocked(listTree).mockResolvedValue([
      treeEntry("README.txt"),
      treeEntry("README.md"),
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("README.md");
  });

  it("matches case-insensitively (readme.md → README.md slot)", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("readme.md")] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("readme.md");
  });

  it("ignores tree-type entries named README (directories)", async () => {
    vi.mocked(listTree).mockResolvedValue([
      { mode: "040000", type: "tree", sha: "abc", path: "README", name: "README" },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when no README file exists in the directory", async () => {
    vi.mocked(listTree).mockResolvedValue([
      treeEntry("main.ts"),
      treeEntry("package.json"),
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an empty directory", async () => {
    vi.mocked(listTree).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Query parameters ─────────────────────────────────────────────────────────

describe("?ref and ?path query params", () => {
  it("passes the ?ref param to listTree and readFileAtBranch", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("README.md")] as never);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme?ref=v1.0.0" });
    expect(listTree).toHaveBeenCalledWith("alice/my-repo.git", "v1.0.0", "");
    expect(readFileAtBranch).toHaveBeenCalledWith("alice/my-repo.git", "v1.0.0", "README.md");
  });

  it("scans a subdirectory when ?path is given", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("README.md", "src")] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme?path=src" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("src/README.md");
    expect(listTree).toHaveBeenCalledWith("alice/my-repo.git", "main", "src");
  });

  it("uses default branch when ?ref is omitted", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("README.md")] as never);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(listTree).toHaveBeenCalledWith("alice/my-repo.git", "main", "");
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe("response shape", () => {
  it("returns path, name, ref, and content", async () => {
    vi.mocked(listTree).mockResolvedValue([treeEntry("README.md")] as never);
    vi.mocked(readFileAtBranch).mockResolvedValue("# My Project\n\nWelcome.");
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme?ref=main" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      path: "README.md",
      name: "README.md",
      ref: "main",
      content: "# My Project\n\nWelcome.",
    });
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("returns 404 for guest on private repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_PRIVATE_REPO as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/readme" });
    expect(res.statusCode).toBe(404);
  });

  it("allows owner to read README of private repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_PRIVATE_REPO as never);
    vi.mocked(listTree).mockResolvedValue([treeEntry("README.md")] as never);
    const auth = await authHeader(app, "user-1");
    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/readme",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/nobody/no-repo/readme" });
    expect(res.statusCode).toBe(404);
  });
});
