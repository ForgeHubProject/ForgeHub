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
      update: vi.fn(),
      delete: vi.fn(),
    },
    repoCollaborator: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    label: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    issue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    issueComment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    issueLabel: {
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../notifications-service.js", () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../timeline-service.js", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
  emitHeadPushedForPush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../references-service.js", () => ({
  syncBodyReferences: vi.fn().mockResolvedValue(undefined),
  closeIssuesForMergedPull: vi.fn().mockResolvedValue(undefined),
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
  performMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
  performMergeWithResolvedFiles: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
  branchShas: vi.fn().mockResolvedValue([]),
  listFilesDifferingBetweenBranches: vi.fn().mockResolvedValue([]),
  readFileAtBranch: vi.fn().mockResolvedValue(null),
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

const OWNER_ID = "user-owner-issues";
const AUTHOR_ID = "user-author-issues";
const OTHER_ID = "user-other-issues";

function makeRepo(overrides = {}) {
  return {
    id: "repo-issues-1",
    name: "my-repo",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: { handle: "alice" },
    collaborators: [],
    ...overrides,
  };
}

function makeLabel(overrides = {}) {
  return {
    id: "label-1",
    repoId: "repo-issues-1",
    name: "bug",
    color: "d73a4a",
    description: "Something isn't working",
    createdAt: new Date(),
    ...overrides,
  };
}

function makeIssue(overrides = {}) {
  return {
    id: "issue-1",
    repoId: "repo-issues-1",
    number: 1,
    title: "Fix the thing",
    body: "This is broken",
    state: "OPEN" as const,
    authorId: AUTHOR_ID,
    assigneeId: null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "dev" },
    assignee: null,
    labels: [],
    _count: { comments: 0 },
    ...overrides,
  };
}

function makeComment(overrides = {}) {
  return {
    id: "comment-1",
    issueId: "issue-1",
    authorId: AUTHOR_ID,
    body: "This is a comment",
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "dev" },
    ...overrides,
  };
}

// ─── Label Tests ──────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/labels", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.label.findMany).mockResolvedValue([] as never);
  });

  it("200 with empty array when no labels exist", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/labels" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.labels).toEqual([]);
  });

  it("200 with labels list", async () => {
    vi.mocked(prisma.label.findMany).mockResolvedValue([makeLabel()] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/labels" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0].name).toBe("bug");
    expect(body.labels[0].color).toBe("d73a4a");
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/no-repo/labels" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /repos/:handle/:name/labels", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.label.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.label.create).mockResolvedValue(makeLabel() as never);
  });

  it("201 with created label", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      headers: { authorization: ownerToken },
      payload: { name: "bug", color: "d73a4a", description: "Something isn't working" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("bug");
    expect(body.color).toBe("d73a4a");
    expect(body.description).toBe("Something isn't working");
  });

  it("400 when color is invalid hex", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      headers: { authorization: ownerToken },
      payload: { name: "bug", color: "gggggg" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/hex/i);
  });

  it("400 when color is wrong length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      headers: { authorization: ownerToken },
      payload: { name: "bug", color: "d73a4" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when name is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      headers: { authorization: ownerToken },
      payload: { color: "d73a4a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when label name already exists on repo", async () => {
    vi.mocked(prisma.label.findFirst).mockResolvedValue(makeLabel() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      headers: { authorization: ownerToken },
      payload: { name: "bug", color: "d73a4a" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already exists/i);
  });

  it("401 when not authenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/labels",
      payload: { name: "bug", color: "d73a4a" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /repos/:handle/:name/labels/:labelId", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.label.findFirst).mockResolvedValue(makeLabel() as never);
    vi.mocked(prisma.label.update).mockResolvedValue(makeLabel({ name: "enhancement", color: "a2eeef" }) as never);
  });

  it("200 with updated fields", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/labels/label-1",
      headers: { authorization: ownerToken },
      payload: { name: "enhancement", color: "a2eeef" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("enhancement");
    expect(body.color).toBe("a2eeef");
  });

  it("404 when label not found", async () => {
    vi.mocked(prisma.label.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/labels/nonexistent",
      headers: { authorization: ownerToken },
      payload: { name: "enhancement" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 when color is invalid", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/labels/label-1",
      headers: { authorization: ownerToken },
      payload: { color: "zzz" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /repos/:handle/:name/labels/:labelId", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.label.findFirst).mockResolvedValue(makeLabel() as never);
    vi.mocked(prisma.label.delete).mockResolvedValue(makeLabel() as never);
  });

  it("204 on successful delete", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/labels/label-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("404 when label not found", async () => {
    vi.mocked(prisma.label.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/labels/nonexistent",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Issue Tests ──────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/issues", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([makeIssue()] as never);
  });

  it("200 with list (default open)", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].number).toBe(1);
    expect(body.issues[0].state).toBe("open");
  });

  it("filters by state=closed", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValue([makeIssue({ state: "CLOSED" })] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues?state=closed" });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.issue.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: "CLOSED" }) }),
    );
  });

  it("filters by state=all returns all issues", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      makeIssue({ state: "OPEN" }),
      makeIssue({ id: "issue-2", number: 2, state: "CLOSED" }),
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues?state=all" });
    expect(res.statusCode).toBe(200);
    const calls = vi.mocked(prisma.issue.findMany).mock.calls;
    const lastCall = calls[calls.length - 1]![0] as { where: Record<string, unknown> };
    expect(lastCall.where["state"]).toBeUndefined();
    expect(res.json().issues).toHaveLength(2);
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/no-repo/issues" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /repos/:handle/:name/issues", () => {
  let app: FastifyInstance;
  let authorToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      return fn(prisma as unknown as typeof prisma);
    });
    vi.mocked(prisma.issue.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.issue.create).mockResolvedValue(makeIssue() as never);
  });

  it("201 with number=1 for first issue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues",
      headers: { authorization: authorToken },
      payload: { title: "Fix the thing", body: "This is broken" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.state).toBe("open");
    expect(body.title).toBe("Fix the thing");
  });

  it("401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues",
      payload: { title: "Fix the thing" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 when title is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues",
      headers: { authorization: authorToken },
      payload: { body: "just a body" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title/i);
  });
});

describe("GET /repos/:handle/:name/issues/:number", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(
      makeIssue({
        labels: [{ label: { id: "label-1", name: "bug", color: "d73a4a" } }],
        _count: { comments: 3 },
      }) as never,
    );
  });

  it("200 with full detail including labels and commentCount", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues/1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.title).toBe("Fix the thing");
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0].name).toBe("bug");
    expect(body.commentCount).toBe(3);
    expect(body.closedAt).toBeNull();
  });

  it("404 for non-existent number", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });
});

describe("PATCH /repos/:handle/:name/issues/:number", () => {
  let app: FastifyInstance;
  let authorToken: string;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
    ownerToken = await authHeader(app, OWNER_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issue.update).mockResolvedValue(makeIssue({ title: "Updated title" }) as never);
  });

  it("200 updating title", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: authorToken },
      payload: { title: "Updated title" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Updated title");
  });

  it("sets closedAt when state=closed", async () => {
    const closedAt = new Date();
    vi.mocked(prisma.issue.update).mockResolvedValue(
      makeIssue({ state: "CLOSED", closedAt }) as never,
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: authorToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("closed");
    expect(res.json().closedAt).not.toBeNull();
    // Verify update was called with closedAt
    expect(vi.mocked(prisma.issue.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "CLOSED", closedAt: expect.any(Date) }),
      }),
    );
  });

  it("clears closedAt when state=open after close", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue({ state: "CLOSED", closedAt: new Date() }) as never);
    vi.mocked(prisma.issue.update).mockResolvedValue(makeIssue({ state: "OPEN", closedAt: null }) as never);
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: authorToken },
      payload: { state: "open" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("open");
    expect(res.json().closedAt).toBeNull();
    expect(vi.mocked(prisma.issue.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "OPEN", closedAt: null }),
      }),
    );
  });

  it("403 when not author and not owner", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: otherToken },
      payload: { title: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("200 when owner updates issue", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: ownerToken },
      payload: { title: "Owner update" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400 for invalid state value", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: authorToken },
      payload: { state: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /repos/:handle/:name/issues/:number", () => {
  let app: FastifyInstance;
  let authorToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issue.delete).mockResolvedValue(makeIssue() as never);
  });

  it("204 on successful delete by author", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: authorToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("403 when not author and not owner", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: otherToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Comment Tests ────────────────────────────────────────────────────────────

describe("Comments on issues", () => {
  let app: FastifyInstance;
  let authorToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issueComment.findMany).mockResolvedValue([makeComment()] as never);
    vi.mocked(prisma.issueComment.findFirst).mockResolvedValue(makeComment() as never);
    vi.mocked(prisma.issueComment.create).mockResolvedValue(makeComment() as never);
    vi.mocked(prisma.issueComment.update).mockResolvedValue(makeComment({ body: "Edited comment" }) as never);
    vi.mocked(prisma.issueComment.delete).mockResolvedValue(makeComment() as never);
  });

  it("POST comment → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues/1/comments",
      headers: { authorization: authorToken },
      payload: { body: "This is a comment" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.body).toBe("This is a comment");
    expect(body.author).toBeDefined();
  });

  it("GET comments → 200 with list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/issues/1/comments",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe("This is a comment");
  });

  it("PATCH comment → 200 (author can edit)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1/comments/comment-1",
      headers: { authorization: authorToken },
      payload: { body: "Edited comment" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe("Edited comment");
  });

  it("PATCH comment → 403 (non-author cannot edit)", async () => {
    vi.mocked(prisma.issueComment.findFirst).mockResolvedValue(
      makeComment({ authorId: AUTHOR_ID }) as never,
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/issues/1/comments/comment-1",
      headers: { authorization: otherToken },
      payload: { body: "Trying to edit" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE comment → 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/issues/1/comments/comment-1",
      headers: { authorization: authorToken },
    });
    expect(res.statusCode).toBe(204);
  });
});

// ─── Issue Labels Tests ───────────────────────────────────────────────────────

describe("Issue labels", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.label.findFirst).mockResolvedValue(makeLabel() as never);
    vi.mocked(prisma.issueLabel.findFirst).mockResolvedValue({ issueId: "issue-1", labelId: "label-1" } as never);
    vi.mocked(prisma.issueLabel.create).mockResolvedValue({ issueId: "issue-1", labelId: "label-1" } as never);
    vi.mocked(prisma.issueLabel.delete).mockResolvedValue({ issueId: "issue-1", labelId: "label-1" } as never);
  });

  it("POST issue label → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues/1/labels",
      headers: { authorization: ownerToken },
      payload: { labelId: "label-1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.issueId).toBe("issue-1");
    expect(body.labelId).toBe("label-1");
  });

  it("DELETE issue label → 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/issues/1/labels/label-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
  });
});
