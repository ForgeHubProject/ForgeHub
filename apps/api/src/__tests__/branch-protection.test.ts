import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";

// ─── Module mocks (hoisted) — mirror the pulls-route unit harness ─────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ handle: "merger", displayName: "Merl", email: "m@forgehub.io" }),
    },
    repo: { findFirst: vi.fn() },
    pullRequest: { findFirst: vi.fn(), update: vi.fn() },
    pullRequestReview: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestReviewComment: { findMany: vi.fn().mockResolvedValue([]) },
    protectedBranch: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
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
vi.mock("../webhook-service.js", () => ({
  emitRepoEvent: vi.fn().mockResolvedValue(undefined),
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
  performSquashMerge: vi.fn().mockResolvedValue({ ok: true, sha: "5qua5h00" }),
  performRebaseMerge: vi.fn().mockResolvedValue({ ok: true, sha: "reba5e00" }),
  performRevert: vi.fn().mockResolvedValue({ ok: true, branch: "revert-pr-1", sha: "revert00" }),
  listMergeBaseCommits: vi.fn().mockResolvedValue([]),
  countAheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 0 }),
  listBranches: vi.fn().mockResolvedValue([]),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
}));
vi.mock("../merge/resolve-pull.js", () => ({
  resolvePullRequestMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
}));
vi.mock("../ingest.js", () => ({ ingestCommitRange: vi.fn().mockResolvedValue(undefined) }));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { evaluateMergeProtection, getCheckSummary, type ProtectionRuleRow } from "../branch-protection.js";
import type { FastifyInstance } from "fastify";

const OWNER_ID = "user-owner";
const HEAD_SHA = "abc1234";

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    name: "my-repo",
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID,
    owner: { handle: "alice" },
    collaborators: [],
    ...overrides,
  };
}
function makePR(overrides: Record<string, unknown> = {}) {
  return {
    id: "pr-1", repoId: "repo-1", number: 1, title: "Feature", description: null,
    fromBranch: "feature", toBranch: "main", state: "OPEN" as const, mergedAt: null,
    authorId: "author-1", createdAt: new Date(), updatedAt: new Date(),
    author: { handle: "dev", displayName: "Dev" },
    ...overrides,
  };
}
function rule(overrides: Partial<ProtectionRuleRow> = {}): ProtectionRuleRow {
  return { requirePullRequest: false, requiredApprovals: 0, requireGreenChecks: false, blockForcePush: false, ...overrides };
}
/** A submitted review row as review-summary reads it. */
function review(state: string, commitSha: string | null, authorId = "r1") {
  return { authorId, state, submittedAt: new Date(), commitSha, author: { handle: `rev-${authorId}` } };
}

// ─── Pure evaluation ──────────────────────────────────────────────────────────

describe("evaluateMergeProtection (pure)", () => {
  it("blocks when approvals fall short of the requirement", () => {
    const s = evaluateMergeProtection(rule({ requiredApprovals: 2 }), "main", { approvals: 1, changesRequested: 0 }, null);
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/requires 2 approving reviews/i);
    expect(s.rules.find((r) => r.key === "approvals")?.satisfied).toBe(false);
  });

  it("allows when enough approvals and no change requests", () => {
    const s = evaluateMergeProtection(rule({ requiredApprovals: 2 }), "main", { approvals: 2, changesRequested: 0 }, null);
    expect(s.blocked).toBe(false);
    expect(s.rules.find((r) => r.key === "approvals")?.satisfied).toBe(true);
  });

  it("blocks on an active change request even with enough approvals", () => {
    const s = evaluateMergeProtection(rule({ requiredApprovals: 1 }), "main", { approvals: 3, changesRequested: 1 }, null);
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/active change request/i);
  });

  it("does not block for green checks when no checks are configured (null)", () => {
    const s = evaluateMergeProtection(rule({ requireGreenChecks: true }), "main", { approvals: 0, changesRequested: 0 }, null);
    expect(s.blocked).toBe(false);
    expect(s.rules.find((r) => r.key === "checks")?.detail).toMatch(/no checks configured/i);
  });

  it("blocks when checks are pending", () => {
    const s = evaluateMergeProtection(rule({ requireGreenChecks: true }), "main", { approvals: 0, changesRequested: 0 }, { total: 3, passing: 2, failing: 0, pending: 1 });
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/1 pending/);
  });

  it("blocks when checks are failing", () => {
    const s = evaluateMergeProtection(rule({ requireGreenChecks: true }), "main", { approvals: 0, changesRequested: 0 }, { total: 3, passing: 2, failing: 1, pending: 0 });
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/1 failing/);
  });

  it("allows when all checks pass", () => {
    const s = evaluateMergeProtection(rule({ requireGreenChecks: true }), "main", { approvals: 0, changesRequested: 0 }, { total: 3, passing: 3, failing: 0, pending: 0 });
    expect(s.blocked).toBe(false);
    expect(s.rules.find((r) => r.key === "checks")?.satisfied).toBe(true);
  });
});

// ─── getCheckSummary consumer (404-tolerant) ──────────────────────────────────

describe("getCheckSummary (in-process consumer)", () => {
  it("returns null when the endpoint is absent (404 → no checks configured)", async () => {
    const app = Fastify();
    await app.ready();
    expect(await getCheckSummary(app, "alice", "repo", "sha1")).toBeNull();
    await app.close();
  });

  it("parses a 200 payload and defaults missing counts", async () => {
    const app = Fastify();
    app.get("/repos/:handle/:name/commits/:sha/check-summary", async () => ({ total: 4, passing: 2, failing: 1, pending: 1 }));
    await app.ready();
    expect(await getCheckSummary(app, "alice", "repo", "sha1")).toEqual({ total: 4, passing: 2, failing: 1, pending: 1 });
    await app.close();
  });

  it("treats a malformed body (no total) as no checks", async () => {
    const app = Fastify();
    app.get("/repos/:handle/:name/commits/:sha/check-summary", async () => ({ nope: true }));
    await app.ready();
    expect(await getCheckSummary(app, "alice", "repo", "sha1")).toBeNull();
    await app.close();
  });
});

// ─── Rule CRUD (routes) ───────────────────────────────────────────────────────

describe("branch protection rule CRUD", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  beforeAll(async () => { app = await createTestServer(); ownerToken = await authHeader(app, OWNER_ID); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    // storageKey:null → the git-transport config sync is skipped for CRUD.
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ storageKey: null }) as never);
  });

  it("PUT stores the rule set and echoes it back", async () => {
    vi.mocked(prisma.protectedBranch.upsert).mockResolvedValue({} as never);
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/branches/main/protection",
      headers: { authorization: ownerToken },
      payload: { requirePullRequest: true, requiredApprovals: 2, requireGreenChecks: true, blockForcePush: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules).toEqual({ requirePullRequest: true, requiredApprovals: 2, requireGreenChecks: true, blockForcePush: true });
    const call = vi.mocked(prisma.protectedBranch.upsert).mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(call.create).toMatchObject({ requirePullRequest: true, requiredApprovals: 2 });
  });

  it("PUT rejects a negative requiredApprovals", async () => {
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/branches/main/protection",
      headers: { authorization: ownerToken },
      payload: { requiredApprovals: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT is owner-only", async () => {
    const strangerToken = await authHeader(app, "someone-else");
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/branches/main/protection",
      headers: { authorization: strangerToken },
      payload: { requirePullRequest: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET returns the stored rules (default when unprotected)", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValueOnce(null);
    const unprot = await app.inject({ method: "GET", url: "/repos/alice/my-repo/branches/main/protection" });
    expect(unprot.json().protected).toBe(false);
    expect(unprot.json().rules.requiredApprovals).toBe(0);

    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValueOnce({
      requirePullRequest: true, requiredApprovals: 3, requireGreenChecks: false, blockForcePush: true,
    } as never);
    const prot = await app.inject({ method: "GET", url: "/repos/alice/my-repo/branches/main/protection" });
    expect(prot.json().protected).toBe(true);
    expect(prot.json().rules.requiredApprovals).toBe(3);
  });

  it("DELETE clears protection (204)", async () => {
    vi.mocked(prisma.protectedBranch.deleteMany).mockResolvedValue({ count: 1 } as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/branches/main/protection",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.protectedBranch.deleteMany)).toHaveBeenCalled();
  });
});

// ─── Merge-endpoint hard gate ─────────────────────────────────────────────────

describe("merge endpoint enforces branch protection (hard gate)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    // The real CI check-summary route serves the protection gate; no runs → 404.
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(makePR() as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue(makePR({ state: "MERGED" }) as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
  });

  function merge(payload: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/repos/alice/my-repo/pulls/1/merge", headers: { authorization: ownerToken }, payload });
  }

  it("409s a required-approvals branch with no approvals", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requiredApprovals: 1 }) as never);
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().protection).toBe(true);
    expect(res.json().error).toMatch(/requires 1 approving review/i);
  });

  it("merges once the branch has N fresh approvals", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requiredApprovals: 1 }) as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([review("APPROVED", HEAD_SHA)] as never);
    const res = await merge();
    expect(res.statusCode).toBe(200);
    expect(res.json().merged).toBe(true);
  });

  it("does not count a stale approval (left against an old head)", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requiredApprovals: 1 }) as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([review("APPROVED", "stale-sha")] as never);
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().protection).toBe(true);
  });

  it("ignores override:true for a protection block", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requiredApprovals: 1 }) as never);
    const res = await merge({ override: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().protection).toBe(true);
  });

  it("blocks when an active change request stands under a required-approvals rule", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requiredApprovals: 1 }) as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue(
      [review("APPROVED", HEAD_SHA, "r1"), review("CHANGES_REQUESTED", HEAD_SHA, "r2")] as never,
    );
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/change request/i);
  });

  it("requireGreenChecks does NOT block when the sha has no runs (check-summary 404)", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requireGreenChecks: true }) as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    const res = await merge();
    expect(res.statusCode).toBe(200);
  });

  it("requireGreenChecks blocks when a check is pending", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requireGreenChecks: true }) as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }, { status: "running", conclusion: null }] },
    ] as never);
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/status checks/i);
  });

  it("requireGreenChecks blocks when a check is failing", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requireGreenChecks: true }) as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] },
    ] as never);
    const res = await merge();
    expect(res.statusCode).toBe(409);
  });

  it("requireGreenChecks allows when all checks pass", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(rule({ requireGreenChecks: true }) as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "success" }] },
    ] as never);
    const res = await merge();
    expect(res.statusCode).toBe(200);
  });

  it("does not gate an unprotected branch", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null);
    const res = await merge();
    expect(res.statusCode).toBe(200);
  });
});
