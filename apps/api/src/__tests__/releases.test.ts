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
  readFileAtBranch: vi.fn().mockResolvedValue(null),
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn().mockResolvedValue(undefined),
  deleteTag: vi.fn().mockResolvedValue(undefined),
  tagExists: vi.fn().mockResolvedValue(true),
  cloneMirror: vi.fn(),
  git: vi.fn(),
  listCommits: vi.fn().mockResolvedValue([]),
  getCommit: vi.fn().mockResolvedValue(null),
  listTree: vi.fn().mockResolvedValue([]),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { tagExists, createTag } from "../git-utils.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REPO = {
  id: "repo-1",
  name: "my-repo",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "alice/my-repo.git",
  collaborators: [],
};

const MOCK_PRIVATE_REPO = { ...MOCK_REPO, visibility: "PRIVATE" };

const MOCK_WRITER_REPO = {
  ...MOCK_REPO,
  collaborators: [{ userId: "writer-1", role: "WRITER" }],
};

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRelease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rel-1",
    tagName: "v1.0.0",
    name: "Version 1.0.0",
    body: "First stable release",
    isDraft: false,
    isPrerelease: false,
    author: { handle: "alice" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerToken: string;
let writerToken: string;

beforeAll(async () => {
  app = await createTestServer();
  ownerToken = await authHeader(app, "user-1");
  writerToken = await authHeader(app, "writer-1");
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(tagExists).mockResolvedValue(true);
});

// ─── GET /releases ────────────────────────────────────────────────────────────

describe("GET /repos/:h/:r/releases", () => {
  it("returns empty list when there are no releases", async () => {
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases" });
    expect(res.statusCode).toBe(200);
    expect(res.json().releases).toEqual([]);
  });

  it("returns published releases with formatted fields", async () => {
    vi.mocked(prisma.release.findMany).mockResolvedValue([makeRelease()] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases" });
    expect(res.statusCode).toBe(200);
    const { releases } = res.json();
    expect(releases).toHaveLength(1);
    expect(releases[0].tagName).toBe("v1.0.0");
    expect(releases[0].name).toBe("Version 1.0.0");
    expect(releases[0].author).toBe("alice");
    expect(releases[0].isDraft).toBe(false);
  });

  it("non-writer does not see drafts (where clause includes isDraft:false)", async () => {
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases" });
    const call = vi.mocked(prisma.release.findMany).mock.calls.at(-1)![0] as { where: Record<string, unknown> };
    expect(call.where.isDraft).toBe(false);
  });

  it("writer sees drafts (no isDraft filter)", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_WRITER_REPO as never);
    vi.mocked(prisma.release.findMany).mockResolvedValue([]);
    await app.inject({
      method: "GET", url: "/repos/alice/my-repo/releases",
      headers: { authorization: writerToken },
    });
    const call = vi.mocked(prisma.release.findMany).mock.calls.at(-1)![0] as { where: Record<string, unknown> };
    expect(call.where.isDraft).toBeUndefined();
  });

  it("returns 404 for unknown repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/nobody/no-repo/releases" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /releases/latest ─────────────────────────────────────────────────────

describe("GET /repos/:h/:r/releases/latest", () => {
  it("returns the latest non-draft non-prerelease release", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/latest" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tagName).toBe("v1.0.0");
  });

  it("returns 404 when there is no qualifying release", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/latest" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /releases/tags/:tag ──────────────────────────────────────────────────

describe("GET /repos/:h/:r/releases/tags/:tag", () => {
  it("returns release for a known tag", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/tags/v1.0.0" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tagName).toBe("v1.0.0");
  });

  it("returns 404 for unknown tag", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/tags/v99.0" });
    expect(res.statusCode).toBe(404);
  });

  it("hides draft release from non-writer", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease({ isDraft: true }) as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/tags/v1.0.0" });
    expect(res.statusCode).toBe(404);
  });

  it("shows draft release to writer", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_WRITER_REPO as never);
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease({ isDraft: true }) as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/releases/tags/v1.0.0",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── POST /releases ───────────────────────────────────────────────────────────

describe("POST /repos/:h/:r/releases", () => {
  it("creates a release when the git tag already exists", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.release.create).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: ownerToken },
      payload: { tagName: "v1.0.0", name: "Version 1.0.0", body: "First stable release" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tagName).toBe("v1.0.0");
    expect(createTag).not.toHaveBeenCalled();
  });

  it("creates git tag + release when tag does not exist and targetCommitish is given", async () => {
    vi.mocked(tagExists).mockResolvedValue(false);
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.release.create).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: ownerToken },
      payload: { tagName: "v1.0.0", targetCommitish: "abc1234" },
    });
    expect(res.statusCode).toBe(201);
    expect(createTag).toHaveBeenCalledWith("alice/my-repo.git", "v1.0.0", "abc1234", "v1.0.0");
  });

  it("returns 422 when tag does not exist and targetCommitish is missing", async () => {
    vi.mocked(tagExists).mockResolvedValue(false);
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: ownerToken },
      payload: { tagName: "v2.0.0" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("returns 409 when a release for that tag already exists", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: ownerToken },
      payload: { tagName: "v1.0.0" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 400 for missing tagName", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: ownerToken },
      payload: { name: "No tag" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for non-writer", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      headers: { authorization: await authHeader(app, "outsider") },
      payload: { tagName: "v1.0.0" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 for unauthenticated user", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/releases",
      payload: { tagName: "v1.0.0" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── PATCH /releases/:id ─────────────────────────────────────────────────────

describe("PATCH /repos/:h/:r/releases/:id", () => {
  it("updates name, body, isDraft, isPrerelease", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    vi.mocked(prisma.release.update).mockResolvedValue(
      makeRelease({ name: "Updated", isDraft: true }) as never,
    );
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/releases/rel-1",
      headers: { authorization: ownerToken },
      payload: { name: "Updated", isDraft: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Updated");
    expect(res.json().isDraft).toBe(true);
  });

  it("returns 404 when release does not exist", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/releases/bad-id",
      headers: { authorization: ownerToken },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for non-writer", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/releases/rel-1",
      headers: { authorization: await authHeader(app, "outsider") },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── DELETE /releases/:id ─────────────────────────────────────────────────────

describe("DELETE /repos/:h/:r/releases/:id", () => {
  it("deletes the release record and returns 204", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    vi.mocked(prisma.release.delete).mockResolvedValue(makeRelease() as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/releases/rel-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("does NOT delete the underlying git tag", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
    vi.mocked(prisma.release.delete).mockResolvedValue(makeRelease() as never);
    const { deleteTag } = await import("../git-utils.js");
    await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/releases/rel-1",
      headers: { authorization: ownerToken },
    });
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it("returns 404 when release does not exist", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/releases/bad-id",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for non-writer", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/releases/rel-1",
      headers: { authorization: await authHeader(app, "outsider") },
    });
    expect(res.statusCode).toBe(403);
  });
});
