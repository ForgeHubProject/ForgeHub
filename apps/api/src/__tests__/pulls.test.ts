import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ handle: "merger", displayName: "Merl Merger", email: "merl@forgehub.io" }),
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
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    milestone: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    // Review summary (merge gate + PR detail) reads these; default to "no reviews".
    pullRequestReview: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pullRequestReviewComment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Branch protection (#85) — default to "not protected" so the merge/detail
    // paths behave as before unless a test opts in.
    protectedBranch: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // Auto-merge's check-summary gate (#119) — default to "no runs" (green).
    workflowRun: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Viewed-file bookkeeping (#119).
    pullRequestFileView: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    personalAccessToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
  listMergeBaseCommits: vi.fn().mockResolvedValue([{ subject: "first" }, { subject: "second" }]),
  getMergeBaseFileList: vi.fn().mockResolvedValue([
    { path: "src/a.ts", additions: 3, deletions: 1, binary: false, status: "modified" },
    { path: "docs/b.md", additions: 5, deletions: 0, binary: false, status: "added" },
  ]),
  listChangedPaths: vi.fn().mockResolvedValue([]),
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

vi.mock("../merge/resolve-pull.js", () => ({
  resolvePullRequestMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
}));

vi.mock("../ingest.js", () => ({
  ingestCommitRange: vi.fn().mockResolvedValue(undefined),
}));

// Server-side merges fan out `push` webhooks + push CI through this helper
// (wave-B MINOR-1). Mock it so we can assert the merge handlers wire it with the
// right branch/sha; the helper's own effects are unit-tested in push-events.test.ts.
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
import { emitPushEvents, ZERO_SHA } from "../push-events.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-owner-pr";
const AUTHOR_ID = "user-author-pr";

function makeRepo(overrides = {}) {
  return {
    id: "repo-pr-1",
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

function makePR(overrides = {}) {
  return {
    id: "pr-1",
    repoId: "repo-pr-1",
    number: 1,
    title: "Add feature",
    description: null,
    fromBranch: "feature",
    toBranch: "main",
    state: "OPEN" as const,
    mergedAt: null,
    authorId: AUTHOR_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    author: { handle: "dev", displayName: "Dev" },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/pulls", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([makePR()] as never);
  });

  it("200 with pulls list for a public repo", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pulls).toHaveLength(1);
    expect(body.pulls[0].number).toBe(1);
    expect(body.pulls[0].state).toBe("open");
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/no-repo/pulls" });
    expect(res.statusCode).toBe(404);
  });

  it("filters by state=closed", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls?state=closed" });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.pullRequest.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: "CLOSED" }) }),
    );
  });

  it("filters by state=merged", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls?state=merged" });
    expect(vi.mocked(prisma.pullRequest.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: "MERGED" }) }),
    );
  });

  it("state=all returns no state filter", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls?state=all" });
    const calls = vi.mocked(prisma.pullRequest.findMany).mock.calls;
    const lastCall = calls[calls.length - 1]![0] as { where: Record<string, unknown> };
    expect(lastCall.where["state"]).toBeUndefined();
  });
});

describe("POST /repos/:handle/:name/pulls", () => {
  let app: FastifyInstance;
  let authorToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ ownerId: "other-owner" }) as never,
    );
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(null); // no duplicate
    vi.mocked(prisma.pullRequest.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.pullRequest.create).mockResolvedValue(makePR() as never);
  });

  it("201 for a valid PR body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { title: "Add feature", fromBranch: "feature", toBranch: "main" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.state).toBe("open");
  });

  it("400 when title is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { fromBranch: "feature" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title/i);
  });

  it("400 when fromBranch is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { title: "PR" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/fromBranch/i);
  });

  it("400 when fromBranch equals toBranch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { title: "Self PR", fromBranch: "main", toBranch: "main" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/differ/i);
  });

  it("400 when fromBranch does not exist", async () => {
    const { branchExists } = await import("../git-utils.js");
    vi.mocked(branchExists).mockResolvedValueOnce(false);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { title: "PR", fromBranch: "ghost-branch" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when a duplicate open PR exists for the same branch pair", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      headers: { authorization: authorToken },
      payload: { title: "Duplicate", fromBranch: "feature" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/open pull request/i);
  });

  it("401 when not authenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls",
      payload: { title: "PR", fromBranch: "feature" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /repos/:handle/:name/pulls/:number", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
  });

  it("200 with PR details", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.fromBranch).toBe("feature");
    expect(body.toBranch).toBe("main");
  });

  it("404 when PR number does not exist", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/999" });
    expect(res.statusCode).toBe(404);
  });

  it("includes mergeable field for open PRs", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.json().mergeable).toBeDefined();
  });

  it("reports the armed auto-merge intent on an OPEN PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ autoMergeMethod: "squash", autoMergeById: OWNER_ID }) as never,
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "merger" } as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.json().autoMerge).toEqual({ method: "squash", by: "merger" });
  });

  // Regression (issue #119): a terminal PR must never advertise a pending
  // auto-merge, even if a row written before the columns were cleared survives.
  it("reports autoMerge as null on a merged PR that still carries the columns", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "MERGED", autoMergeMethod: "squash", autoMergeById: OWNER_ID }) as never,
    );
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.json().autoMerge).toBeNull();
  });
});

describe("PATCH /repos/:handle/:name/pulls/:number", () => {
  let app: FastifyInstance;
  let authorToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    authorToken = await authHeader(app, AUTHOR_ID);
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "CLOSED" }) as never);
  });

  it("200 when author closes their PR", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: authorToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("closed");
  });

  it("200 when owner closes a PR", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: ownerToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400 for invalid state value", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: authorToken },
      payload: { state: "merged" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403 when a stranger tries to close the PR", async () => {
    const strangerToken = await authHeader(app, "stranger");
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: strangerToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409 when trying to change state of a merged PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "MERGED", authorId: AUTHOR_ID }) as never,
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: authorToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /repos/:handle/:name/pulls/:number/merge", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);
  });

  it("200 with merged=true and sha on success", async () => {
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockResolvedValueOnce({ ok: true, sha: "deadbeef" });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(true);
    expect(res.json().sha).toBe("deadbeef");
    expect(res.json().method).toBe("merge");
  });

  // Regression (issue #119): the armed intent is spent once the PR merges —
  // leaving it set made `GET /pulls/:number` report auto-merge as still armed.
  it("clears the armed auto-merge intent when the PR merges", async () => {
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockResolvedValueOnce({ ok: true, sha: "deadbeef" });

    await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "MERGED", autoMergeMethod: null, autoMergeById: null }),
      }),
    );
  });

  it("defaults to the merge method (performMerge) when none is supplied", async () => {
    const { performMerge, performSquashMerge, performRebaseMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockClear();
    vi.mocked(performSquashMerge).mockClear();
    vi.mocked(performRebaseMerge).mockClear();

    await app.inject({ method: "POST", url: "/repos/alice/my-repo/pulls/1/merge", headers: { authorization: ownerToken } });
    expect(vi.mocked(performMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(performSquashMerge)).not.toHaveBeenCalled();
    expect(vi.mocked(performRebaseMerge)).not.toHaveBeenCalled();
  });

  it("routes mergeMethod=squash through performSquashMerge and records the method", async () => {
    const { performSquashMerge } = await import("../git-utils.js");
    vi.mocked(performSquashMerge).mockClear().mockResolvedValueOnce({ ok: true, sha: "5qua5h00" });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "squash" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().method).toBe("squash");
    expect(res.json().sha).toBe("5qua5h00");
    expect(vi.mocked(performSquashMerge)).toHaveBeenCalledTimes(1);
    // Persists the method + resulting sha on the PR record.
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mergeMethod: "squash", mergeCommitSha: "5qua5h00" }) }),
    );
  });

  it("routes mergeMethod=rebase through performRebaseMerge", async () => {
    const { performRebaseMerge } = await import("../git-utils.js");
    vi.mocked(performRebaseMerge).mockClear().mockResolvedValueOnce({ ok: true, sha: "reba5e00" });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "rebase" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().method).toBe("rebase");
    expect(vi.mocked(performRebaseMerge)).toHaveBeenCalledTimes(1);
  });

  it("400 for an unknown mergeMethod", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "octopus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/mergeMethod/i);
  });

  it("409 with a rebase-specific message when the replay conflicts", async () => {
    const { performRebaseMerge } = await import("../git-utils.js");
    vi.mocked(performRebaseMerge).mockResolvedValueOnce({ ok: false, conflicts: true });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "rebase" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/rebase/i);
    expect(res.json().resolvable).toBe(true);
  });

  it("409 when merge has conflicts", async () => {
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockResolvedValueOnce({ ok: false, conflicts: true });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409 when branch is already merged", async () => {
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockResolvedValueOnce({ ok: false, alreadyMerged: true });

    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409 when PR is not open", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "CLOSED" }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("403 when caller has no write access", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ ownerId: "other", collaborators: [] }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401 when not authenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /repos/:handle/:name/pulls/:number/merge — review gate", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  // A submitted CHANGES_REQUESTED review left against the current head SHA.
  function changesRequestedReview(overrides = {}) {
    return {
      id: "rev-1", pullRequestId: "pr-1", authorId: "user-reviewer",
      state: "CHANGES_REQUESTED", body: null, submittedAt: new Date(),
      commitSha: "abc1234", createdAt: new Date(), updatedAt: new Date(),
      author: { handle: "reviewer" }, ...overrides,
    };
  }

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
  });

  it("409 when an active change request blocks the merge", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([changesRequestedReview()] as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().changesRequested).toBe(true);
    expect(res.json().error).toMatch(/changes were requested/i);
  });

  it("merges anyway with override:true", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([changesRequestedReview()] as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { override: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(true);
  });

  it("stale change request (head moved) no longer blocks — dismiss-on-push", async () => {
    // Review was left against an old head; resolveBranchSha resolves head to abc1234.
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      changesRequestedReview({ commitSha: "oldsha0" }),
    ] as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(true);
  });
});

describe("GET /repos/:handle/:name/pulls/:number — review summary", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
  });

  it("includes a reviewSummary with counts, dropping stale approvals", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      { id: "r1", authorId: "u1", state: "APPROVED", submittedAt: new Date(1), commitSha: "abc1234", author: { handle: "amy" } },
      { id: "r2", authorId: "u2", state: "APPROVED", submittedAt: new Date(2), commitSha: "stale00", author: { handle: "ben" } },
      { id: "r3", authorId: "u3", state: "CHANGES_REQUESTED", submittedAt: new Date(3), commitSha: "abc1234", author: { handle: "cid" } },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.statusCode).toBe(200);
    const s = res.json().reviewSummary;
    expect(s.approvals).toBe(1);          // amy counts, ben is stale
    expect(s.changesRequested).toBe(1);   // cid
    expect(s.staleCount).toBe(1);         // ben
    expect(s.reviewers).toHaveLength(3);
  });
});

describe("POST /repos/:handle/:name/pulls/:number/revert", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  const mergedPR = () => makePR({ state: "MERGED", mergedAt: new Date(), mergeMethod: "merge", mergeCommitSha: "mergesha1" });

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    const { branchExists, performRevert } = await import("../git-utils.js");
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(performRevert).mockResolvedValue({ ok: true, branch: "revert-pr-1", sha: "revert00" });
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(mergedPR() as never);
    vi.mocked(prisma.pullRequest.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.pullRequest.create).mockReset().mockResolvedValue(
      makePR({ id: "pr-revert", number: 2, title: 'Revert "Add feature" (!1)', fromBranch: "revert-pr-1" }) as never,
    );
  });

  it("201 opens a reverting PR for a merged PR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe(2);
    expect(body.fromBranch).toBe("revert-pr-1");
    expect(body.title).toMatch(/^Revert /);
    // The new PR cross-links the original.
    expect(vi.mocked(prisma.pullRequest.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromBranch: "revert-pr-1", description: "Reverts #1." }) }),
    );
  });

  it("409 when the PR is not merged", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR({ state: "OPEN" }) as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/merged/i);
  });

  it("409 when no merge commit sha is recorded", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "MERGED", mergedAt: new Date(), mergeCommitSha: null }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409 when the revert conflicts, with a clear no-manual-resolution message", async () => {
    const { performRevert } = await import("../git-utils.js");
    vi.mocked(performRevert).mockResolvedValueOnce({ ok: false, conflicts: true });
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/conflict/i);
    expect(vi.mocked(prisma.pullRequest.create)).not.toHaveBeenCalled();
  });

  it("409 when a revert branch already exists", async () => {
    const { branchExists } = await import("../git-utils.js");
    vi.mocked(branchExists).mockResolvedValue(true);
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already exists/i);
  });

  it("403 when caller lacks write access", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ ownerId: "other", collaborators: [] }) as never,
    );
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401 when not authenticated", async () => {
    const res = await app.inject({ method: "POST", url: "/repos/alice/my-repo/pulls/1/revert" });
    expect(res.statusCode).toBe(401);
  });
});

// ─── wave-B MINOR-1: merges fan out `push` webhooks + push CI ──────────────────

describe("merge/revert push fan-out (wave-B MINOR-1)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    vi.mocked(emitPushEvents).mockClear();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
    const { performMerge, resolveBranchSha, branchExists, performRevert } = await import("../git-utils.js");
    vi.mocked(resolveBranchSha).mockResolvedValue("abc1234");
    vi.mocked(performMerge).mockResolvedValue({ ok: true, sha: "deadbeef" });
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(performRevert).mockResolvedValue({ ok: true, branch: "revert-pr-1", sha: "revert00" });
  });

  it("fires a `push` fan-out for the target branch tip on a successful merge", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(emitPushEvents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitPushEvents)).toHaveBeenCalledWith(
      "repo-pr-1", "alice/my-repo.git", OWNER_ID,
      [{ branch: "main", oldSha: "abc1234", newSha: "deadbeef" }],
    );
  });

  it("fires a `push` fan-out on a successful merge-resolve", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge-resolve",
      headers: { authorization: ownerToken },
      payload: { strategy: "ours" },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(emitPushEvents)).toHaveBeenCalledWith(
      "repo-pr-1", "alice/my-repo.git", OWNER_ID,
      [{ branch: "main", oldSha: "abc1234", newSha: "deadbeef" }],
    );
  });

  it("fires a `push` fan-out for the new revert branch (zero before-sha)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "MERGED", mergedAt: new Date(), mergeMethod: "merge", mergeCommitSha: "mergesha1" }) as never,
    );
    vi.mocked(prisma.pullRequest.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.pullRequest.create).mockResolvedValue(
      makePR({ id: "pr-revert", number: 2, fromBranch: "revert-pr-1" }) as never,
    );

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/revert",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(emitPushEvents)).toHaveBeenCalledWith(
      "repo-pr-1", "alice/my-repo.git", OWNER_ID,
      [{ branch: "revert-pr-1", oldSha: ZERO_SHA, newSha: "revert00" }],
    );
  });

  it("does NOT fire a `push` fan-out when branch protection blocks the merge (409)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    // Protected: requires 2 approvals, but the PR has none → hard-gate block.
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue({
      requirePullRequest: true, requiredApprovals: 2, requireGreenChecks: false, blockForcePush: false,
    } as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().protection).toBe(true);
    expect(vi.mocked(emitPushEvents)).not.toHaveBeenCalled();
  });

  it("does NOT fire a `push` fan-out when the merge conflicts (409)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockResolvedValueOnce({ ok: false, conflicts: true });

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
    expect(vi.mocked(emitPushEvents)).not.toHaveBeenCalled();
  });
});

// ─── issue #119: per-repo merge policy on the merge endpoint ───────────────────

describe("merge endpoint honors the repo merge policy (issue #119)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);
  });

  it("400s a method the repo does not allow", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ allowedMergeMethods: "merge", defaultMergeMethod: "merge" }) as never,
    );
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "squash" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not allowed/i);
  });

  it("defaults to the repo's defaultMergeMethod when none is supplied", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ allowedMergeMethods: "merge,squash", defaultMergeMethod: "squash" }) as never,
    );
    const { performSquashMerge } = await import("../git-utils.js");
    vi.mocked(performSquashMerge).mockClear().mockResolvedValueOnce({ ok: true, sha: "5qua5h00" });

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().method).toBe("squash");
    expect(vi.mocked(performSquashMerge)).toHaveBeenCalledTimes(1);
  });

  it("surfaces the policy on the PR detail payload", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ allowedMergeMethods: "merge,rebase", defaultMergeMethod: "rebase" }) as never,
    );
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergePolicy).toEqual({ allowedMethods: ["merge", "rebase"], defaultMethod: "rebase" });
  });
});

// ─── issue #119: auto-merge arm / cancel endpoints ─────────────────────────────

describe("POST/DELETE /repos/:handle/:name/pulls/:number/auto-merge (issue #119)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockClear().mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
  });

  it("stores the intent (method + arming user)", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "rebase" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoMerge).toEqual({ method: "rebase", by: "merger" });
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoMergeMethod: "rebase", autoMergeById: OWNER_ID } }),
    );
  });

  it("merges IMMEDIATELY when every gate is already green at arm time", async () => {
    // First findFirst → the route's lookup (not yet armed); second → the
    // evaluation's re-load, now carrying the stored intent.
    vi.mocked(prisma.pullRequest.findFirst)
      .mockResolvedValueOnce(makePR() as never)
      .mockResolvedValueOnce(makePR({ autoMergeMethod: "merge", autoMergeById: OWNER_ID }) as never);
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockClear().mockResolvedValueOnce({ ok: true, sha: "deadbeef" });

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "merge" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(true);
    expect(res.json().sha).toBe("deadbeef");
    expect(vi.mocked(performMerge)).toHaveBeenCalledTimes(1);
    // The firing persisted the MERGED state.
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "MERGED", mergeMethod: "merge" }) }),
    );
  });

  it("stays armed (merged=false) while a change request keeps the review gate red", async () => {
    vi.mocked(prisma.pullRequest.findFirst)
      .mockResolvedValueOnce(makePR() as never)
      .mockResolvedValueOnce(makePR({ autoMergeMethod: "merge", autoMergeById: OWNER_ID }) as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([{
      id: "rev-1", pullRequestId: "pr-1", authorId: "user-reviewer",
      state: "CHANGES_REQUESTED", body: null, submittedAt: new Date(),
      commitSha: "abc1234", createdAt: new Date(), updatedAt: new Date(),
      author: { handle: "reviewer" },
    }] as never);
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockClear();

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(false);
    expect(vi.mocked(performMerge)).not.toHaveBeenCalled();
  });

  it("stays armed (merged=false) while checks are pending", async () => {
    vi.mocked(prisma.pullRequest.findFirst)
      .mockResolvedValueOnce(makePR() as never)
      .mockResolvedValueOnce(makePR({ autoMergeMethod: "merge", autoMergeById: OWNER_ID }) as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "running", conclusion: null }] },
    ] as never);
    const { performMerge } = await import("../git-utils.js");
    vi.mocked(performMerge).mockClear();

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(false);
    expect(vi.mocked(performMerge)).not.toHaveBeenCalled();
  });

  it("400s arming with a method the repo policy does not allow", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ allowedMergeMethods: "merge", defaultMergeMethod: "merge" }) as never,
    );
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
      payload: { mergeMethod: "squash" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not allowed/i);
  });

  it("409s arming a non-open PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR({ state: "CLOSED" }) as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("403s a caller without write access", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ ownerId: "other", collaborators: [] }) as never,
    );
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE disarms an armed PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ autoMergeMethod: "squash", autoMergeById: OWNER_ID }) as never,
    );
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoMerge).toBeNull();
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoMergeMethod: null, autoMergeById: null } }),
    );
  });

  it("DELETE 409s when auto-merge is not armed", async () => {
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/pulls/1/auto-merge",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("closing a PR disarms auto-merge", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ autoMergeMethod: "merge", autoMergeById: OWNER_ID }) as never,
    );
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "CLOSED" }) as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/pulls/1",
      headers: { authorization: ownerToken },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "CLOSED", autoMergeMethod: null, autoMergeById: null }),
      }),
    );
  });
});

// ─── issue #119: viewed-file state on the files view ───────────────────────────

describe("PR viewed files (issue #119)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequestFileView.findMany).mockClear().mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequestFileView.upsert).mockClear();
    vi.mocked(prisma.pullRequestFileView.deleteMany).mockClear();
  });

  it("files payload stamps the caller's viewed state per entry", async () => {
    vi.mocked(prisma.pullRequestFileView.findMany).mockResolvedValue([
      { filePath: "src/a.ts" },
    ] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/my-repo/pulls/1/files",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    const files = res.json().files as Array<{ path: string; viewed: boolean }>;
    expect(files.find((f) => f.path === "src/a.ts")?.viewed).toBe(true);
    expect(files.find((f) => f.path === "docs/b.md")?.viewed).toBe(false);
  });

  it("anonymous readers get viewed: false without a lookup", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/pulls/1/files" });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.pullRequestFileView.findMany)).not.toHaveBeenCalled();
    expect((res.json().files as Array<{ viewed: boolean }>).every((f) => f.viewed === false)).toBe(true);
  });

  it("PUT viewed-files marks a file viewed (upsert on the composite key)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/pulls/1/viewed-files",
      headers: { authorization: ownerToken },
      payload: { path: "src/a.ts", viewed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "src/a.ts", viewed: true });
    expect(vi.mocked(prisma.pullRequestFileView.upsert)).toHaveBeenCalledWith({
      where: { pullRequestId_userId_filePath: { pullRequestId: "pr-1", userId: OWNER_ID, filePath: "src/a.ts" } },
      create: { pullRequestId: "pr-1", userId: OWNER_ID, filePath: "src/a.ts" },
      update: { viewedAt: expect.any(Date) },
    });
  });

  it("PUT viewed-files with viewed:false clears the row", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/pulls/1/viewed-files",
      headers: { authorization: ownerToken },
      payload: { path: "src/a.ts", viewed: false },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.pullRequestFileView.deleteMany)).toHaveBeenCalledWith({
      where: { pullRequestId: "pr-1", userId: OWNER_ID, filePath: "src/a.ts" },
    });
    expect(vi.mocked(prisma.pullRequestFileView.upsert)).not.toHaveBeenCalled();
  });

  it("400s a missing path or non-boolean viewed", async () => {
    const noPath = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/pulls/1/viewed-files",
      headers: { authorization: ownerToken },
      payload: { viewed: true },
    });
    expect(noPath.statusCode).toBe(400);

    const badViewed = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/pulls/1/viewed-files",
      headers: { authorization: ownerToken },
      payload: { path: "src/a.ts", viewed: "yes" },
    });
    expect(badViewed.statusCode).toBe(400);
  });

  it("401s an anonymous PUT", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/pulls/1/viewed-files",
      payload: { path: "src/a.ts", viewed: true },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── wave-B MAJOR-2: PAT scope enforcement on PR write endpoints ───────────────

describe("PAT scope enforcement on PR write endpoints (wave-B MAJOR-2)", () => {
  const READ_PAT = "fhp_read_pr";
  const WRITE_PAT = "fhp_write_pr";
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Two PATs owned by the repo owner (so a 403 proves the scope gate, not
    // missing repo/write access): one read-only, one with repo:write.
    vi.mocked(prisma.personalAccessToken.findUnique).mockImplementation(((args: { where: { tokenHash: string } }) => {
      if (args.where.tokenHash === hashToken(READ_PAT)) return Promise.resolve({ id: "pat-read", userId: OWNER_ID, scopes: "repo:read", expiresAt: null });
      if (args.where.tokenHash === hashToken(WRITE_PAT)) return Promise.resolve({ id: "pat-write", userId: OWNER_ID, scopes: "repo:read,repo:write", expiresAt: null });
      return Promise.resolve(null);
    }) as never);
    vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);
    const { resolveBranchSha, performMerge } = await import("../git-utils.js");
    vi.mocked(resolveBranchSha).mockResolvedValue("abc1234");
    vi.mocked(performMerge).mockResolvedValue({ ok: true, sha: "deadbeef" });
  });

  const readHdr = { authorization: `Bearer ${READ_PAT}` };

  it("403s a repo:read PAT creating a PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls",
      headers: readHdr, payload: { title: "x", fromBranch: "feature" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
    expect(vi.mocked(prisma.pullRequest.create)).not.toHaveBeenCalled();
  });

  it("403s a repo:read PAT merging a PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge", headers: readHdr,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });

  it("403s a repo:read PAT resolving+merging a PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge-resolve",
      headers: readHdr, payload: { strategy: "ours" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
  });

  it("403s a repo:read PAT reverting a PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      makePR({ state: "MERGED", mergedAt: new Date(), mergeCommitSha: "mergesha1" }) as never,
    );
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/revert", headers: readHdr,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
    expect(vi.mocked(prisma.pullRequest.create)).not.toHaveBeenCalled();
  });

  it("403s a repo:read PAT changing PR state (PATCH)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/pulls/1",
      headers: readHdr, payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });

  it("lets a repo:write PAT and a session token merge (gate passes)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);

    const viaPat = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: `Bearer ${WRITE_PAT}` },
    });
    expect(viaPat.statusCode).toBe(200);

    const viaSession = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/1/merge",
      headers: { authorization: ownerToken },
    });
    expect(viaSession.statusCode).toBe(200);
  });
});
