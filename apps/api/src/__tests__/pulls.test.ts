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
