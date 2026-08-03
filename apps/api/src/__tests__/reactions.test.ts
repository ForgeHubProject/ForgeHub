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
    issue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    issueComment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pullRequest: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    pullRequestComment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pullRequestReview: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    pullRequestReviewComment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    timelineEvent: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
    reaction: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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

const OWNER_ID = "user-owner-reactions";
const OTHER_ID = "user-other-reactions";

function makeRepo(overrides = {}) {
  return {
    id: "repo-react-1",
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

function makeIssue(overrides = {}) {
  return {
    id: "issue-react-1",
    repoId: "repo-react-1",
    number: 1,
    title: "Fix the thing",
    body: "This is broken",
    state: "OPEN" as const,
    authorId: OWNER_ID,
    assigneeId: null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "alice" },
    assignee: null,
    labels: [],
    _count: { comments: 0 },
    ...overrides,
  };
}

/** A stored reaction row as the grouped-rollup query selects it. */
function row(subjectId: string, emoji: string, userId: string) {
  return { subjectId, emoji, userId };
}

const PUT_URL = "/repos/alice/my-repo/reactions";

// ─── PUT /repos/:handle/:name/reactions ───────────────────────────────────────

describe("PUT /repos/:handle/:name/reactions", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    // Clear call history so per-test `mock.calls[0]` assertions see only this test.
    vi.mocked(prisma.issue.findFirst).mockClear().mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.pullRequestComment.findFirst).mockClear();
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockClear();
    vi.mocked(prisma.reaction.findMany).mockClear().mockResolvedValue([] as never);
    vi.mocked(prisma.reaction.upsert).mockClear().mockResolvedValue({} as never);
  });

  it("401 without auth", async () => {
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404 for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OTHER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 on an unknown subjectType", async () => {
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "release", subjectId: "rel-1", emoji: "+1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("subjectType");
  });

  it("400 when subjectId is missing", async () => {
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", emoji: "+1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("subjectId");
  });

  it("400 on an emoji outside the fixed set of 8", async () => {
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "shrug" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("emoji");
    expect(vi.mocked(prisma.reaction.upsert)).not.toHaveBeenCalled();
  });

  it("404 when the subject does not exist in this repo", async () => {
    // The route pins the subject lookup to the URL repo's id, so an issue from
    // another repo resolves to nothing.
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-elsewhere", emoji: "+1" },
    });
    expect(res.statusCode).toBe(404);
    const where = vi.mocked(prisma.issue.findFirst).mock.calls[0]![0]!.where;
    expect(where).toMatchObject({ id: "issue-elsewhere", repoId: "repo-react-1" });
  });

  it("adds via upsert on the uniqueness key (idempotent) and returns the rollup", async () => {
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("issue-react-1", "+1", OWNER_ID),
      row("issue-react-1", "+1", OTHER_ID),
    ] as never);

    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subjectType: "issue",
      subjectId: "issue-react-1",
      reactions: { "+1": 2 },
      viewerReacted: ["+1"],
    });

    // Idempotency comes from upserting on the @@unique constraint with a no-op update.
    expect(vi.mocked(prisma.reaction.upsert)).toHaveBeenCalledWith({
      where: {
        subjectType_subjectId_userId_emoji: {
          subjectType: "ISSUE", subjectId: "issue-react-1", userId: OWNER_ID, emoji: "+1",
        },
      },
      create: { subjectType: "ISSUE", subjectId: "issue-react-1", userId: OWNER_ID, emoji: "+1" },
      update: {},
    });
  });

  it("reacts to a PR comment (subject resolved through its pull request's repo)", async () => {
    vi.mocked(prisma.pullRequestComment.findFirst).mockResolvedValue({ id: "prc-1" } as never);

    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "pr_comment", subjectId: "prc-1", emoji: "rocket" },
    });

    expect(res.statusCode).toBe(200);
    const where = vi.mocked(prisma.pullRequestComment.findFirst).mock.calls[0]![0]!.where;
    expect(where).toMatchObject({ id: "prc-1", pullRequest: { repoId: "repo-react-1" } });
  });

  it("404 when reacting to someone else's PENDING review comment", async () => {
    // The visibility filter (submitted OR own pending draft) is part of the
    // lookup where — a non-author resolves nothing and sees a plain 404.
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(null);

    const res = await app.inject({
      method: "PUT", url: PUT_URL,
      headers: { authorization: await authHeader(app, OTHER_ID) },
      payload: { subjectType: "pr_review_comment", subjectId: "prrc-1", emoji: "eyes" },
    });

    expect(res.statusCode).toBe(404);
    const where = vi.mocked(prisma.pullRequestReviewComment.findFirst).mock.calls[0]![0]!.where;
    expect(where).toMatchObject({
      id: "prrc-1",
      pullRequest: { repoId: "repo-react-1" },
      OR: [{ review: { state: { not: "PENDING" } } }, { review: { authorId: OTHER_ID } }],
    });
  });
});

// ─── DELETE /repos/:handle/:name/reactions ────────────────────────────────────

describe("DELETE /repos/:handle/:name/reactions", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.reaction.findMany).mockClear().mockResolvedValue([] as never);
    vi.mocked(prisma.reaction.deleteMany).mockClear().mockResolvedValue({ count: 1 } as never);
  });

  it("401 without auth", async () => {
    const res = await app.inject({
      method: "DELETE", url: PUT_URL,
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("removes only the caller's own reaction and returns the fresh rollup", async () => {
    // heart from someone else survives the caller removing their own +1.
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("issue-react-1", "heart", OTHER_ID),
    ] as never);

    const res = await app.inject({
      method: "DELETE", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "+1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subjectType: "issue",
      subjectId: "issue-react-1",
      reactions: { heart: 1 },
      viewerReacted: [],
    });
    expect(vi.mocked(prisma.reaction.deleteMany)).toHaveBeenCalledWith({
      where: { subjectType: "ISSUE", subjectId: "issue-react-1", userId: OWNER_ID, emoji: "+1" },
    });
  });

  it("is idempotent — deleting a reaction that was never added still 200s", async () => {
    vi.mocked(prisma.reaction.deleteMany).mockResolvedValue({ count: 0 } as never);
    const res = await app.inject({
      method: "DELETE", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "eyes" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reactions).toEqual({});
  });

  it("400 on an emoji outside the fixed set", async () => {
    const res = await app.inject({
      method: "DELETE", url: PUT_URL,
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { subjectType: "issue", subjectId: "issue-react-1", emoji: "sparkles" },
    });
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(prisma.reaction.deleteMany)).not.toHaveBeenCalled();
  });
});

// ─── Payload enrichment: grouped counts + viewer state ────────────────────────

describe("reaction enrichment on issue payloads", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    // Clear call history so the "ONE grouped query" assertions see only this test.
    vi.mocked(prisma.reaction.findMany).mockClear().mockResolvedValue([] as never);
  });

  it("GET issue detail carries grouped counts + viewerReacted in canonical order", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    // Insertion order is scrambled on purpose — the rollup re-orders canonically.
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("issue-react-1", "eyes", OWNER_ID),
      row("issue-react-1", "+1", OTHER_ID),
      row("issue-react-1", "+1", OWNER_ID),
      row("issue-react-1", "heart", "user-third"),
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reactions).toEqual({ "+1": 2, heart: 1, eyes: 1 });
    expect(Object.keys(body.reactions)).toEqual(["+1", "heart", "eyes"]);
    expect(body.viewerReacted).toEqual(["+1", "eyes"]);
  });

  it("anonymous viewers get counts with an empty viewerReacted", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("issue-react-1", "hooray", OWNER_ID),
    ] as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues/1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().reactions).toEqual({ hooray: 1 });
    expect(res.json().viewerReacted).toEqual([]);
  });

  it("GET issues list batches the rollup into ONE grouped query", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      makeIssue(),
      makeIssue({ id: "issue-react-2", number: 2 }),
    ] as never);
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("issue-react-2", "-1", OTHER_ID),
    ] as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues" });

    expect(res.statusCode).toBe(200);
    const issues = res.json().issues;
    expect(issues[0].reactions).toEqual({});
    expect(issues[1].reactions).toEqual({ "-1": 1 });

    // No N+1: one findMany covering both subject ids.
    expect(vi.mocked(prisma.reaction.findMany)).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.reaction.findMany).mock.calls[0]![0]!.where;
    expect(where).toEqual({
      subjectType: "ISSUE",
      subjectId: { in: ["issue-react-1", "issue-react-2"] },
    });
  });

  it("GET issue comments batches the rollup into ONE grouped query", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issueComment.findMany).mockResolvedValue([
      { id: "c-1", body: "hi", author: { handle: "alice" }, createdAt: new Date(), updatedAt: new Date() },
      { id: "c-2", body: "yo", author: { handle: "bob" }, createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    vi.mocked(prisma.reaction.findMany).mockResolvedValue([
      row("c-2", "laugh", OWNER_ID),
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/issues/1/comments",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });

    expect(res.statusCode).toBe(200);
    const comments = res.json().comments;
    expect(comments[0].reactions).toEqual({});
    expect(comments[1].reactions).toEqual({ laugh: 1 });
    expect(comments[1].viewerReacted).toEqual(["laugh"]);

    expect(vi.mocked(prisma.reaction.findMany)).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.reaction.findMany).mock.calls[0]![0]!.where;
    expect(where).toEqual({ subjectType: "ISSUE_COMMENT", subjectId: { in: ["c-1", "c-2"] } });
  });
});

// ─── Cascade: subject deletion sweeps its reactions ───────────────────────────

describe("reaction cleanup on subject delete", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.reaction.deleteMany).mockClear().mockResolvedValue({ count: 0 } as never);
  });

  it("DELETE issue sweeps the issue's and its comments' reactions", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issueComment.findMany).mockResolvedValue([{ id: "c-1" }, { id: "c-2" }] as never);
    vi.mocked(prisma.issue.delete).mockResolvedValue({} as never);

    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });

    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.reaction.deleteMany)).toHaveBeenCalledWith({
      where: {
        OR: [
          { subjectType: "ISSUE", subjectId: { in: ["issue-react-1"] } },
          { subjectType: "ISSUE_COMMENT", subjectId: { in: ["c-1", "c-2"] } },
        ],
      },
    });
  });

  it("DELETE issue comment sweeps that comment's reactions", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssue() as never);
    vi.mocked(prisma.issueComment.findFirst).mockResolvedValue({
      id: "c-1", issueId: "issue-react-1", authorId: OWNER_ID,
    } as never);
    vi.mocked(prisma.issueComment.delete).mockResolvedValue({} as never);

    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/issues/1/comments/c-1",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });

    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.reaction.deleteMany)).toHaveBeenCalledWith({
      where: { OR: [{ subjectType: "ISSUE_COMMENT", subjectId: { in: ["c-1"] } }] },
    });
  });
});
