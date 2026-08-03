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
    pullRequest: {
      // Default [] so the viewed-reset scan after an applied suggestion no-ops.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    pullRequestComment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pullRequestReview: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pullRequestReviewComment: {
      // Default: none — the review/review-comment DELETE handlers gather ids for
      // their reaction sweep (#90), so this must resolve even when unset.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // Auto-merge gates (#119) — default "not protected" / "no runs" (green).
    protectedBranch: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workflowRun: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Viewed-file reset after an applied suggestion moves the head (#119).
    pullRequestFileView: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Requested reviewers (#82): review submission fulfills an active request.
    pullRequestReviewerRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    personalAccessToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // Reactions (#90) ride on comment payloads — default to "none".
    reaction: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
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
  performSquashMerge: vi.fn().mockResolvedValue({ ok: true, sha: "5qua5h00" }),
  performRebaseMerge: vi.fn().mockResolvedValue({ ok: true, sha: "reba5e00" }),
  performRevert: vi.fn().mockResolvedValue({ ok: true, branch: "revert-pr-1", sha: "revert00" }),
  listMergeBaseCommits: vi.fn().mockResolvedValue([]),
  commitFileToBranch: vi.fn().mockResolvedValue({ ok: true, sha: "sugg0001" }),
  listChangedPaths: vi.fn().mockResolvedValue([]),
  getMergeBaseFileList: vi.fn().mockResolvedValue([]),
  branchShas: vi.fn().mockResolvedValue([]),
  listFilesDifferingBetweenBranches: vi.fn().mockResolvedValue([]),
  readFileAtBranch: vi.fn().mockResolvedValue(null),
  readFileAtBranchExact: vi.fn().mockResolvedValue(null),
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  cloneMirror: vi.fn(),
  git: vi.fn(),
}));

vi.mock("../merge/resolve-pull.js", () => ({
  resolvePullRequestMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
}));

vi.mock("../ingest.js", () => ({
  ingestCommitRange: vi.fn().mockResolvedValue(undefined),
}));

// Applying a suggestion mirrors a client push to the head branch through this
// helper (issue #119); mock it so the fan-out wiring can be asserted.
vi.mock("../push-events.js", () => ({
  emitPushEvents: vi.fn(),
  ZERO_SHA: "0".repeat(40),
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$hashed$"),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { hashToken } from "../tokens.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// alice is the repo owner (ownerId: "user-alice") and the authenticated user in most tests
const ALICE_ID = "user-alice";
// bob is the PR author — used to test "cannot review own PR"
const BOB_ID = "user-bob";
const OTHER_ID = "user-other-prc";

function makeRepo(overrides = {}) {
  return {
    id: "repo-prc-1",
    name: "my-repo",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    ownerId: ALICE_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: { handle: "alice" },
    collaborators: [],
    ...overrides,
  };
}

// PR authored by bob
function makePR(overrides = {}) {
  return {
    id: "pr-prc-1",
    repoId: "repo-prc-1",
    number: 1,
    title: "Add feature",
    description: null,
    fromBranch: "feature",
    toBranch: "main",
    state: "OPEN" as const,
    mergedAt: null,
    authorId: BOB_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "bob", displayName: "Bob" },
    ...overrides,
  };
}

function makePRComment(overrides = {}) {
  return {
    id: "prc-comment-1",
    pullRequestId: "pr-prc-1",
    authorId: ALICE_ID,
    body: "Looks good",
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "alice" },
    ...overrides,
  };
}

function makePRReview(overrides = {}) {
  return {
    id: "review-1",
    pullRequestId: "pr-prc-1",
    authorId: ALICE_ID,
    state: "APPROVED" as const,
    body: "LGTM",
    submittedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "alice" },
    _count: { comments: 0 },
    comments: [],
    ...overrides,
  };
}

function makePendingReview(overrides = {}) {
  return makePRReview({
    id: "review-pending-1",
    state: "PENDING" as const,
    body: null,
    submittedAt: null,
    ...overrides,
  });
}

function makeReviewComment(overrides = {}) {
  return {
    id: "rev-comment-1",
    reviewId: "review-1",
    pullRequestId: "pr-prc-1",
    authorId: ALICE_ID,
    body: "This position looks wrong",
    filePath: "assembly.gltf",
    position: JSON.stringify({ type: "gltf", entityId: "assembly.part-a" }),
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "alice" },
    ...overrides,
  };
}

// ─── General PR Comments ──────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/pulls/:number/comments", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestComment.findMany).mockResolvedValue([makePRComment()] as never);
  });

  it("GET → 200 with list", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1/comments" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe("Looks good");
    expect(body.comments[0].author).toBe("alice");
  });
});

describe("POST /repos/:handle/:name/pulls/:number/comments", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestComment.create).mockResolvedValue(makePRComment() as never);
  });

  it("POST → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/comments",
      headers: { authorization: aliceToken },
      payload: { body: "Looks good" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.body).toBe("Looks good");
    expect(body.author).toBe("alice");
  });

  it("POST → 401 unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/comments",
      payload: { body: "Looks good" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST → 400 empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/comments",
      headers: { authorization: aliceToken },
      payload: { body: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/body/i);
  });
});

describe("PATCH /repos/:handle/:name/pulls/:number/comments/:commentId", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestComment.findFirst).mockResolvedValue(makePRComment() as never);
    vi.mocked(prisma.pullRequestComment.update).mockResolvedValue(
      makePRComment({ body: "Updated comment" }) as never,
    );
  });

  it("PATCH → 200 by author", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1/comments/prc-comment-1",
      headers: { authorization: aliceToken },
      payload: { body: "Updated comment" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe("Updated comment");
  });

  it("PATCH → 403 by non-author", async () => {
    // comment belongs to alice, other user tries to edit
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1/comments/prc-comment-1",
      headers: { authorization: otherToken },
      payload: { body: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /repos/:handle/:name/pulls/:number/comments/:commentId", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestComment.findFirst).mockResolvedValue(makePRComment() as never);
    vi.mocked(prisma.pullRequestComment.delete).mockResolvedValue(makePRComment() as never);
  });

  it("DELETE → 204 by author", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/comments/prc-comment-1",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE → 403 by non-author/non-owner", async () => {
    // comment authored by alice, non-owner OTHER_ID tries to delete
    vi.mocked(prisma.pullRequestComment.findFirst).mockResolvedValue(
      makePRComment({ authorId: ALICE_ID }) as never,
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/comments/prc-comment-1",
      headers: { authorization: otherToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Reviews ──────────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/pulls/:number/reviews", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([makePRReview()] as never);
  });

  it("GET → 200 with list", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1/reviews" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].state).toBe("approved");
    expect(body.reviews[0].author).toBe("alice");
  });
});

describe("POST /repos/:handle/:name/pulls/:number/reviews", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    bobToken = await authHeader(app, BOB_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePRReview() as never);
  });

  it("POST → 201 creates submitted review", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "approved", body: "LGTM" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.state).toBe("approved");
    expect(body.author).toBe("alice");
  });

  it("POST → 422 when author tries to review own PR (PR authorId = userId)", async () => {
    // bob is the PR author; bob tries to review his own PR
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: bobToken },
      payload: { state: "approved", body: "Self-approving" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/own pull request/i);
  });

  it("403s a repo:read PAT submitting a review; a session token passes (wave-B MAJOR-2)", async () => {
    const READ_PAT = "fhp_read_review";
    // A repo:read PAT owned by alice (a non-author with repo access): a 403 here
    // proves the scope gate fired, not the author or access checks.
    vi.mocked(prisma.personalAccessToken.findUnique).mockImplementation(((args: { where: { tokenHash: string } }) =>
      Promise.resolve(args.where.tokenHash === hashToken(READ_PAT)
        ? { id: "pat-read", userId: ALICE_ID, scopes: "repo:read", expiresAt: null }
        : null)) as never);
    vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);

    const denied = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: `Bearer ${READ_PAT}` },
      payload: { state: "approved", body: "LGTM" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain("repo:write");
    expect(vi.mocked(prisma.pullRequestReview.create)).not.toHaveBeenCalled();

    // The unscoped session token still submits the review.
    const ok = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "approved", body: "LGTM" },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe("GET /repos/:handle/:name/pulls/:number/reviews/:reviewId", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(
      makePRReview({
        comments: [makeReviewComment()],
      }) as never,
    );
  });

  it("GET single → 200 with comments array", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("review-1");
    expect(body.state).toBe("approved");
    expect(Array.isArray(body.comments)).toBe(true);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].filePath).toBe("assembly.gltf");
    expect(body.comments[0].position).toEqual({ type: "gltf", entityId: "assembly.part-a" });
  });
});

describe("PUT /repos/:handle/:name/pulls/:number/reviews/:reviewId", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    // default: pending review owned by alice
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(makePendingReview() as never);
    vi.mocked(prisma.pullRequestReview.update).mockResolvedValue(
      makePRReview({ id: "review-pending-1", state: "APPROVED" as const, submittedAt: new Date() }) as never,
    );
  });

  it("PUT (submit) → 200 transitions PENDING → APPROVED", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-pending-1",
      headers: { authorization: aliceToken },
      payload: { state: "approved" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("approved");
  });

  it("PUT → 422 if review is already submitted", async () => {
    // Override with a non-pending review
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(
      makePRReview({ state: "APPROVED" as const }) as never,
    );
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-1",
      headers: { authorization: aliceToken },
      payload: { state: "approved" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/PENDING/);
  });
});

describe("DELETE /repos/:handle/:name/pulls/:number/reviews/:reviewId", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(makePendingReview() as never);
    vi.mocked(prisma.pullRequestReview.delete).mockResolvedValue(makePendingReview() as never);
  });

  it("DELETE pending → 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-pending-1",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE submitted → 422", async () => {
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(
      makePRReview({ state: "APPROVED" as const }) as never,
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-1",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/PENDING/);
  });
});

// ─── Inline Review Comments ───────────────────────────────────────────────────

describe("POST /repos/:handle/:name/pulls/:number/review-comments", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    bobToken = await authHeader(app, BOB_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    // No existing PENDING review — will be created
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePendingReview() as never);
    vi.mocked(prisma.pullRequestReviewComment.create).mockResolvedValue(makeReviewComment() as never);
  });

  it("POST with valid glTF position → 201, creates pending review automatically", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "This position looks wrong",
        filePath: "assembly.gltf",
        position: { type: "gltf", entityId: "assembly.part-a" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.filePath).toBe("assembly.gltf");
    expect(body.position).toEqual({ type: "gltf", entityId: "assembly.part-a" });
    expect(body.author).toBe("alice");
    // Verify that a PENDING review was created
    expect(vi.mocked(prisma.pullRequestReview.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "PENDING" }) }),
    );
  });

  it("POST with valid text position → 201", async () => {
    vi.mocked(prisma.pullRequestReviewComment.create).mockResolvedValue(
      makeReviewComment({
        filePath: "config.txt",
        position: JSON.stringify({ type: "text", line: 42, side: "incoming" }),
      }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "Why is this hardcoded?",
        filePath: "config.txt",
        position: { type: "text", line: 42, side: "incoming" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.position).toEqual({ type: "text", line: 42, side: "incoming" });
  });

  it("POST → 400 for invalid position (missing type)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "Bad comment",
        filePath: "assembly.gltf",
        position: { entityId: "assembly.part-a" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/type/i);
  });

  it("POST → 400 for text position missing line", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "Bad text comment",
        filePath: "config.txt",
        position: { type: "text", side: "incoming" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/line/i);
  });

  it("POST → 422 when commenting on own PR", async () => {
    // bob is the PR author, and bob tries to post a review comment
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: bobToken },
      payload: {
        body: "Self-comment",
        filePath: "assembly.gltf",
        position: { type: "gltf", entityId: "assembly.part-a" },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/own pull request/i);
  });
});

describe("GET /repos/:handle/:name/pulls/:number/review-comments", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([makeReviewComment()] as never);
  });

  it("GET all → 200 with list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe("This position looks wrong");
    expect(body.comments[0].filePath).toBe("assembly.gltf");
    expect(body.comments[0].position).toEqual({ type: "gltf", entityId: "assembly.part-a" });
  });
});

describe("PATCH /repos/:handle/:name/pulls/:number/review-comments/:commentId", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(makeReviewComment() as never);
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(
      makeReviewComment({ body: "Edited review comment" }) as never,
    );
  });

  it("PATCH → 200 by author", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1",
      headers: { authorization: aliceToken },
      payload: { body: "Edited review comment" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe("Edited review comment");
  });

  it("PATCH → 403 by non-author", async () => {
    // comment belongs to alice, other user tries to edit
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1",
      headers: { authorization: otherToken },
      payload: { body: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /repos/:handle/:name/pulls/:number/review-comments/:commentId", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(makeReviewComment() as never);
    vi.mocked(prisma.pullRequestReviewComment.delete).mockResolvedValue(makeReviewComment() as never);
  });

  it("DELETE → 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(204);
  });
});

// ─── Thread replies ────────────────────────────────────────────────────────────

describe("POST /repos/:handle/:name/pulls/:number/review-comments/:commentId/replies", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    bobToken = await authHeader(app, BOB_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    // Root comment (inReplyToId: null) authored by alice, under review-1.
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      makeReviewComment({ inReplyToId: null }) as never,
    );
    vi.mocked(prisma.pullRequestReviewComment.create).mockResolvedValue(
      makeReviewComment({ id: "reply-1", authorId: BOB_ID, author: { handle: "bob" }, body: "Fixed", inReplyToId: "rev-comment-1" }) as never,
    );
  });

  it("PR author may reply to a reviewer's thread → 201 (no new pending review)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1/replies",
      headers: { authorization: bobToken },
      payload: { body: "Fixed" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.author).toBe("bob");
    expect(body.inReplyToId).toBe("rev-comment-1");
    // Reply attaches to the root's existing review; no review was created.
    expect(vi.mocked(prisma.pullRequestReview.create)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.pullRequestReviewComment.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewId: "review-1", inReplyToId: "rev-comment-1" }) }),
    );
  });

  it("→ 400 when body is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1/replies",
      headers: { authorization: aliceToken },
      payload: { body: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("→ 404 when the target comment is missing", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/ghost/replies",
      headers: { authorization: aliceToken },
      payload: { body: "hello?" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Thread resolution ─────────────────────────────────────────────────────────

describe("POST/DELETE /repos/:handle/:name/pulls/:number/review-comments/:commentId/resolve", () => {
  let app: FastifyInstance;
  let aliceToken: string;   // repo owner (writer)
  let otherToken: string;   // neither writer nor thread author

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
    otherToken = await authHeader(app, OTHER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      makeReviewComment({ inReplyToId: null }) as never,
    );
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(
      makeReviewComment({ resolvedAt: new Date(), resolvedBy: { handle: "alice" } }) as never,
    );
  });

  it("writer resolves a thread → 200 resolved:true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1/resolve",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolved).toBe(true);
    expect(vi.mocked(prisma.pullRequestReviewComment.update)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rev-comment-1" }, data: expect.objectContaining({ resolvedById: ALICE_ID }) }),
    );
  });

  it("non-writer non-author → 403", async () => {
    // root authored by alice; OTHER_ID is not a writer
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1/resolve",
      headers: { authorization: otherToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE unresolves a thread → 200", async () => {
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(
      makeReviewComment({ resolvedAt: null, resolvedById: null }) as never,
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/pulls/1/review-comments/rev-comment-1/resolve",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolved).toBe(false);
    expect(vi.mocked(prisma.pullRequestReviewComment.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolvedAt: null, resolvedById: null }) }),
    );
  });
});

// ─── Suggested changes (issue #119) ────────────────────────────────────────────

describe("review-comment suggestions (issue #119)", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  const textPosition = JSON.stringify({ type: "text", line: 2, side: "incoming" });

  function suggestionComment(overrides = {}) {
    return makeReviewComment({
      id: "sugg-comment-1",
      filePath: "src/a.ts",
      position: textPosition,
      suggestion: "const x = 2;",
      suggestionAppliedAt: null,
      suggestionAppliedById: null,
      suggestionCommitSha: null,
      ...overrides,
    });
  }

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePendingReview() as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
    const { resolveBranchSha, commitFileToBranch, readFileAtBranchExact } = await import("../git-utils.js");
    vi.mocked(resolveBranchSha).mockResolvedValue("abc1234");
    vi.mocked(commitFileToBranch).mockResolvedValue({ ok: true, sha: "sugg0001" });
    vi.mocked(readFileAtBranchExact).mockResolvedValue("const a = 0;\nconst x = 1;\nconst z = 3;\n");
  });

  it("stores a suggestion on an incoming-side text comment and returns it", async () => {
    vi.mocked(prisma.pullRequestReviewComment.create).mockResolvedValue(
      suggestionComment() as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "Prefer 2 here",
        filePath: "src/a.ts",
        position: { type: "text", line: 2, side: "incoming" },
        suggestion: "const x = 2;",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().suggestion).toBe("const x = 2;");
    expect(res.json().suggestionApplied).toBe(false);
    expect(vi.mocked(prisma.pullRequestReviewComment.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ suggestion: "const x = 2;" }) }),
    );
  });

  it("400s a suggestion on a base-side (deleted) line", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "x",
        filePath: "src/a.ts",
        position: { type: "text", line: 2, side: "base" },
        suggestion: "nope",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/incoming/i);
  });

  it("400s a suggestion on a gltf position", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments",
      headers: { authorization: aliceToken },
      payload: {
        body: "x",
        filePath: "assembly.gltf",
        position: { type: "gltf", entityId: "assembly.part-a" },
        suggestion: "nope",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text position/i);
  });

  it("apply commits the replacement to the HEAD branch and stamps the comment", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(
      suggestionComment({ suggestionAppliedAt: new Date(), suggestionAppliedById: ALICE_ID, suggestionCommitSha: "sugg0001" }) as never,
    );
    const { commitFileToBranch } = await import("../git-utils.js");
    const { emitPushEvents } = await import("../push-events.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sha).toBe("sugg0001");
    expect(res.json().suggestionApplied).toBe(true);

    // Line 2 replaced, other lines untouched; compare-and-swap on the head SHA.
    expect(vi.mocked(commitFileToBranch)).toHaveBeenCalledWith(
      "alice/my-repo.git", "feature", "src/a.ts",
      "const a = 0;\nconst x = 2;\nconst z = 3;\n",
      expect.stringMatching(/Apply suggestion/),
      expect.objectContaining({ name: expect.any(String), email: expect.any(String) }),
      "abc1234",
    );
    expect(vi.mocked(prisma.pullRequestReviewComment.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestionAppliedById: ALICE_ID, suggestionCommitSha: "sugg0001" }),
      }),
    );
    // Mirrors a client push to the head branch.
    expect(vi.mocked(emitPushEvents)).toHaveBeenCalledWith(
      "repo-prc-1", "alice/my-repo.git", ALICE_ID,
      [{ branch: "feature", oldSha: "abc1234", newSha: "sugg0001" }],
    );
  });

  it("409s applying an already-applied suggestion", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ suggestionAppliedAt: new Date() }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already applied/i);
  });

  it("400s applying a comment that has no suggestion", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ suggestion: null }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s when the anchored line is out of range at the current head", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ position: JSON.stringify({ type: "text", line: 99, side: "incoming" }) }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/out of range/i);
  });

  it("409s when the head branch moves mid-apply (compare-and-swap)", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    const { commitFileToBranch } = await import("../git-utils.js");
    vi.mocked(commitFileToBranch).mockResolvedValue({ ok: false, conflict: true });
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/moved/i);
  });

  it("403s a non-writer applying a suggestion", async () => {
    const otherToken = await authHeader(app, OTHER_ID);
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: otherToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s applying on a non-open PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR({ state: "MERGED" }) as never);
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
  });

  // Regression: the apply used to read through `readFileAtBranch`, whose `git()`
  // trim ate the file's leading blank line and trailing newline — corrupting the
  // committed content AND shifting the 1-based line the splice targets.
  it("applies against the BYTE-EXACT head content, preserving surrounding whitespace", async () => {
    const exact = "\n  const a = 0;\nconst x = 1;\nconst z = 3;\n\n";
    const { readFileAtBranch, readFileAtBranchExact, commitFileToBranch } = await import("../git-utils.js");
    vi.mocked(readFileAtBranchExact).mockResolvedValue(exact);
    // In the exact content `const x = 1;` is line 3 (the leading blank line is line 1).
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ position: JSON.stringify({ type: "text", line: 3, side: "incoming" }) }) as never,
    );
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(
      suggestionComment({ suggestionAppliedAt: new Date(), suggestionCommitSha: "sugg0001" }) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(commitFileToBranch).mock.calls[0]?.[3]).toBe(
      "\n  const a = 0;\nconst x = 2;\nconst z = 3;\n\n",
    );
    // The trimming helper must not be on this path at all.
    expect(vi.mocked(readFileAtBranch)).not.toHaveBeenCalled();
  });

  // Regression: the apply pushes with FORGEHUB_INTERNAL_PUSH=1, which bypasses
  // the pre-receive protection hook — the rule has to be enforced in the route.
  it("409s applying to a protected head branch that blocks direct pushes", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(
      { id: "pb-1", repoId: "repo-prc-1", branch: "feature", requirePullRequest: true, requiredApprovals: 0, requireGreenChecks: false, blockForcePush: false } as never,
    );
    const { commitFileToBranch } = await import("../git-utils.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().protection).toBe(true);
    expect(res.json().error).toMatch(/direct pushes are blocked/i);
    expect(vi.mocked(prisma.protectedBranch.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { repoId: "repo-prc-1", branch: "feature" } }),
    );
    expect(vi.mocked(commitFileToBranch)).not.toHaveBeenCalled();
  });

  it("applies normally when the head branch is protected WITHOUT a direct-push rule", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(suggestionComment() as never);
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(suggestionComment() as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(
      { id: "pb-1", repoId: "repo-prc-1", branch: "feature", requirePullRequest: false, requiredApprovals: 2, requireGreenChecks: true, blockForcePush: true } as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
  });

  // Regression: a PENDING review is a private draft — its suggestions must not
  // be applyable server-side before the review is submitted.
  it("409s applying a suggestion that belongs to a pending (draft) review", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ review: { state: "PENDING" } }) as never,
    );
    const { commitFileToBranch } = await import("../git-utils.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/pending review/i);
    expect(vi.mocked(commitFileToBranch)).not.toHaveBeenCalled();
  });

  it("applies a suggestion on a SUBMITTED review", async () => {
    vi.mocked(prisma.pullRequestReviewComment.findFirst).mockResolvedValue(
      suggestionComment({ review: { state: "COMMENTED" } }) as never,
    );
    vi.mocked(prisma.pullRequestReviewComment.update).mockResolvedValue(suggestionComment() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/review-comments/sugg-comment-1/apply-suggestion",
      headers: { authorization: aliceToken },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Auto-merge fires from the review-submit signal (issue #119) ───────────────

describe("auto-merge review-submit signal (issue #119)", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  function armedPR(overrides = {}) {
    return makePR({ autoMergeMethod: "merge", autoMergeById: BOB_ID, ...overrides });
  }

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Bob armed the PR, so he must hold write access — the firing path
    // re-checks it (a revoked armer must not merge).
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ collaborators: [{ userId: BOB_ID, role: "WRITER" }] }) as never,
    );
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(armedPR({ state: "MERGED" }) as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
    // The user lookup feeds the squash identity / arm payload; any handle works.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "bob", displayName: "Bob", email: "bob@x.io" } as never);
    const { performMerge, resolveBranchSha } = await import("../git-utils.js");
    vi.mocked(resolveBranchSha).mockResolvedValue("abc1234");
    vi.mocked(performMerge).mockResolvedValue({ ok: true, sha: "deadbeef" });
  });

  it("an APPROVED submission on an armed PR fires the merge as the arming user", async () => {
    // computeReviewSummary sees the (just-created) approval against the head.
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      makePRReview({ commitSha: "abc1234" }),
    ] as never);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePRReview() as never);
    const { performMerge } = await import("../git-utils.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "approved" },
    });
    expect(res.statusCode).toBe(201);

    // The signal is fire-and-forget; wait for the async evaluation to land.
    await vi.waitFor(() => expect(vi.mocked(performMerge)).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: "MERGED", mergeMethod: "merge" }) }),
      ),
    );
  });

  it("a CHANGES_REQUESTED submission does NOT fire", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      makePRReview({ state: "CHANGES_REQUESTED", commitSha: "abc1234" }),
    ] as never);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(
      makePRReview({ state: "CHANGES_REQUESTED" }) as never,
    );
    const { performMerge } = await import("../git-utils.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "changes_requested" },
    });
    expect(res.statusCode).toBe(201);

    // Give the fire-and-forget evaluation a beat, then assert it stayed put.
    await new Promise((r) => setTimeout(r, 25));
    expect(vi.mocked(performMerge)).not.toHaveBeenCalled();
  });

  it("a submission on an UNARMED PR does not merge anything", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([makePRReview({ commitSha: "abc1234" })] as never);
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePRReview() as never);
    const { performMerge } = await import("../git-utils.js");

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "approved" },
    });
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 25));
    expect(vi.mocked(performMerge)).not.toHaveBeenCalled();
  });
});

// ─── Requested-reviewer fulfillment on review submission (issue #82) ───────────

describe("review submission fulfills an active reviewer request (issue #82)", () => {
  let app: FastifyInstance;
  let aliceToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    aliceToken = await authHeader(app, ALICE_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewerRequest.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it("POST reviews (direct submit) stamps fulfilledAt on the reviewer's active request", async () => {
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePRReview() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { state: "approved", body: "LGTM" },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.updateMany)).toHaveBeenCalledWith({
      where: { pullRequestId: "pr-prc-1", userId: ALICE_ID, fulfilledAt: null, dismissedAt: null },
      data: { fulfilledAt: expect.any(Date) },
    });
  });

  it("POST reviews without a state (pending draft) does NOT fulfill", async () => {
    vi.mocked(prisma.pullRequestReview.create).mockResolvedValue(makePendingReview() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/reviews",
      headers: { authorization: aliceToken },
      payload: { body: "draft notes" },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.updateMany)).not.toHaveBeenCalled();
  });

  it("PUT reviews/:id (submit pending) stamps fulfilledAt", async () => {
    vi.mocked(prisma.pullRequestReview.findFirst).mockResolvedValue(makePendingReview() as never);
    vi.mocked(prisma.pullRequestReview.update).mockResolvedValue(
      makePRReview({ id: "review-pending-1", state: "APPROVED" as const, submittedAt: new Date() }) as never,
    );
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/pulls/1/reviews/review-pending-1",
      headers: { authorization: aliceToken },
      payload: { state: "changes_requested" },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.updateMany)).toHaveBeenCalledWith({
      where: { pullRequestId: "pr-prc-1", userId: ALICE_ID, fulfilledAt: null, dismissedAt: null },
      data: { fulfilledAt: expect.any(Date) },
    });
  });
});
