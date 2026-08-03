import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    // Fire-time identity re-check: the arming user must still exist.
    user: {
      findUnique: vi.fn(),
    },
    pullRequest: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    repo: {
      findFirst: vi.fn(),
    },
    // Review summary reads (computeReviewSummary) — default "no reviews".
    pullRequestReview: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pullRequestReviewComment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Branch protection — default "not protected".
    protectedBranch: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // Check summary — default "no runs" (green vacuously).
    workflowRun: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../git-utils.js", () => ({
  resolveBranchSha: vi.fn().mockResolvedValue("head1234"),
}));

// The executor is unit-tested through the merge endpoint; here it is a seam so
// the gate logic and the exactly-once guarantee can be asserted in isolation.
vi.mock("../pull-merge.js", () => ({
  executePullMerge: vi.fn().mockResolvedValue({ status: "merged", sha: "auto0001" }),
  resolveActorIdentity: vi.fn().mockResolvedValue({ name: "Bot", email: "bot@forgehub.io" }),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { executePullMerge } from "../pull-merge.js";
import { resolveBranchSha } from "../git-utils.js";
import {
  checkSummaryForCommit,
  evaluateAutoMergeGates,
  maybeAutoMergeForCommit,
  maybeAutoMergePr,
} from "../auto-merge.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function armedPR(overrides = {}) {
  return {
    id: "pr-am-1",
    repoId: "repo-am-1",
    number: 7,
    title: "Add feature",
    fromBranch: "feature",
    toBranch: "main",
    state: "OPEN" as const,
    autoMergeMethod: "squash",
    autoMergeById: "user-armer",
    ...overrides,
  };
}

/** The repo as `maybeAutoMergePr` loads it: storage + access grants + merge policy. */
function repoRow(overrides = {}) {
  return {
    id: "repo-am-1",
    storageKey: "alice/my-repo.git",
    visibility: "PUBLIC" as const,
    // The armer owns the repo, so the fire-time write check passes by default.
    ownerId: "user-armer",
    collaborators: [],
    allowedMergeMethods: null,
    defaultMergeMethod: null,
    ...overrides,
  };
}

/** A submitted review row against the current head, as computeReviewSummary reads it. */
function review(state: string, overrides = {}) {
  return {
    id: `rev-${state}`, pullRequestId: "pr-am-1", authorId: `user-${state}`,
    state, body: null, submittedAt: new Date(),
    commitSha: "head1234", createdAt: new Date(), updatedAt: new Date(),
    author: { handle: `${state}-reviewer` }, ...overrides,
  };
}

/** WorkflowRun rows shaped for the check-summary rollup. */
function runsWithChecks(...checks: Array<{ status: string; conclusion: string | null }>) {
  return [{ checkRuns: checks }];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR() as never);
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(repoRow() as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-armer" } as never);
  vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pullRequestReviewComment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
  vi.mocked(resolveBranchSha).mockResolvedValue("head1234");
  vi.mocked(executePullMerge).mockResolvedValue({ status: "merged", sha: "auto0001" });
});

// ─── checkSummaryForCommit ────────────────────────────────────────────────────

describe("checkSummaryForCommit", () => {
  it("null when the commit has no runs (mirrors the /check-summary 404 contract)", async () => {
    expect(await checkSummaryForCommit("repo-am-1", "head1234")).toBeNull();
  });

  it("rolls every run's checks into one summary", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }] },
      { checkRuns: [{ status: "running", conclusion: null }, { status: "completed", conclusion: "failure" }] },
    ] as never);
    expect(await checkSummaryForCommit("repo-am-1", "head1234")).toEqual({
      total: 3, passing: 1, failing: 1, pending: 1,
    });
  });
});

// ─── Gate evaluation ──────────────────────────────────────────────────────────

describe("evaluateAutoMergeGates", () => {
  const pr = { id: "pr-am-1", toBranch: "main" };

  it("ready when there are no reviews, no runs, and no protection", async () => {
    const gate = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(gate.ready).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it("blocked by an active change request", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([review("CHANGES_REQUESTED")] as never);
    const gate = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join()).toMatch(/change request/i);
  });

  it("a STALE change request (head moved) no longer blocks", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      review("CHANGES_REQUESTED", { commitSha: "oldhead0" }),
    ] as never);
    const gate = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(gate.ready).toBe(true);
  });

  it("blocked while any check is pending", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue(
      runsWithChecks({ status: "running", conclusion: null }) as never,
    );
    const gate = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join()).toMatch(/pending/i);
  });

  it("blocked while any check is failing", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue(
      runsWithChecks({ status: "completed", conclusion: "failure" }) as never,
    );
    const gate = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join()).toMatch(/failing/i);
  });

  it("blocked by branch protection until required approvals are met", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue({
      requirePullRequest: true, requiredApprovals: 2, requireGreenChecks: false, blockForcePush: false,
    } as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([review("APPROVED")] as never);

    const blocked = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(blocked.ready).toBe(false);
    expect(blocked.reasons.join()).toMatch(/branch protection/i);

    // Second approval satisfies the rule.
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      review("APPROVED", { id: "r1", authorId: "u1" }),
      review("APPROVED", { id: "r2", authorId: "u2" }),
    ] as never);
    const ready = await evaluateAutoMergeGates(pr, "repo-am-1", "head1234");
    expect(ready.ready).toBe(true);
  });

  // Draft PRs (#82) cannot merge at the endpoints either; auto-merge must agree.
  it("blocked while the PR is a draft, even with every other gate green", async () => {
    const gate = await evaluateAutoMergeGates({ ...pr, isDraft: true }, "repo-am-1", "head1234");
    expect(gate.ready).toBe(false);
    expect(gate.reasons).toContain("pull request is a draft");
  });
});

// ─── Firing ───────────────────────────────────────────────────────────────────

describe("maybeAutoMergePr", () => {
  it("fires with the armed method AS the arming user when every gate is green", async () => {
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result).toEqual({ fired: true, sha: "auto0001" });
    expect(vi.mocked(executePullMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executePullMerge)).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-armer",
        mergeMethod: "squash",
        auto: true,
        repo: { id: "repo-am-1", storageKey: "alice/my-repo.git" },
      }),
    );
  });

  it("does NOT fire when the PR is not armed", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(
      armedPR({ autoMergeMethod: null, autoMergeById: null }) as never,
    );
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });

  it("does NOT fire on a non-open PR", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR({ state: "MERGED" }) as never);
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });

  // ── Draft interaction (#82 × #119) ────────────────────────────────────────
  // Arming a draft is legal — "merge this once it's ready" — but the draft flag
  // is a gate, so nothing may merge until it is cleared.
  it("does NOT fire on an armed DRAFT PR whose other gates are all green", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR({ isDraft: true }) as never);
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result).toEqual({ fired: false, reason: "pull request is a draft" });
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
    // Blocked, not disarmed: the intent must survive for the ready-for-review signal.
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });

  it("fires once the same PR is no longer a draft", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR({ isDraft: false }) as never);
    expect(await maybeAutoMergePr("pr-am-1")).toEqual({ fired: true, sha: "auto0001" });
    expect(vi.mocked(executePullMerge)).toHaveBeenCalledTimes(1);
  });

  it("skips a draft PR when the CI-completion signal sweeps armed PRs", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { id: "pr-am-1", fromBranch: "feature" },
    ] as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(armedPR({ isDraft: true }) as never);
    await maybeAutoMergeForCommit("repo-am-1", "head1234");
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });

  it("does NOT fire while the review gate is red", async () => {
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([review("CHANGES_REQUESTED")] as never);
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });

  it("does NOT fire while the check summary is red", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue(
      runsWithChecks({ status: "completed", conclusion: "failure" }) as never,
    );
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });

  it("fires EXACTLY ONCE when both signals race in-process", async () => {
    // Hold the merge open so the second signal arrives mid-flight.
    let releaseMerge: (v: { status: "merged"; sha: string }) => void;
    vi.mocked(executePullMerge).mockImplementationOnce(
      () => new Promise((resolve) => { releaseMerge = resolve; }),
    );

    const first = maybeAutoMergePr("pr-am-1");
    // Give the first call time to pass its gates and enter the executor.
    await vi.waitFor(() => expect(vi.mocked(executePullMerge)).toHaveBeenCalledTimes(1));

    const second = await maybeAutoMergePr("pr-am-1"); // in-flight → bails
    expect(second).toEqual({ fired: false, reason: "already evaluating" });

    releaseMerge!({ status: "merged", sha: "auto0001" });
    const firstResult = await first;
    expect(firstResult).toEqual({ fired: true, sha: "auto0001" });
    expect(vi.mocked(executePullMerge)).toHaveBeenCalledTimes(1);
  });

  // Regression: the method is validated when arming, but the owner can narrow
  // `allowedMergeMethods` afterwards — the firing path has to re-check.
  it("does NOT fire when the armed method is no longer allowed by the repo policy", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      repoRow({ allowedMergeMethods: "merge", defaultMergeMethod: "merge" }) as never,
    );
    const result = await maybeAutoMergePr("pr-am-1"); // armed with "squash"
    expect(result.fired).toBe(false);
    expect("reason" in result && result.reason).toMatch(/no longer allowed/i);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
    // Intent kept — widening the policy again should resume it.
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });

  it("still fires when the armed method is inside a narrowed policy", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      repoRow({ allowedMergeMethods: "squash,rebase", defaultMergeMethod: "squash" }) as never,
    );
    expect(await maybeAutoMergePr("pr-am-1")).toEqual({ fired: true, sha: "auto0001" });
  });

  // Regression: the schema documents "a missing user is a disarm"; the firing
  // path used to merge anyway, as a ghost `ForgeHub <merge@forgehub.io>` author.
  it("DISARMS instead of merging when the arming user no longer exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect("reason" in result && result.reason).toMatch(/no longer exists/i);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoMergeMethod: null, autoMergeById: null } }),
    );
  });

  // Regression: write access can be revoked between arming and firing.
  it("does NOT fire when the arming user's write access was revoked", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      repoRow({ ownerId: "someone-else", collaborators: [{ userId: "user-armer", role: "READER" }] }) as never,
    );
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result.fired).toBe(false);
    expect("reason" in result && result.reason).toMatch(/write access/i);
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
    // Stays armed — restoring access should resume the intent.
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });

  it("fires for an arming user who holds write access as a WRITER collaborator", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      repoRow({ ownerId: "someone-else", collaborators: [{ userId: "user-armer", role: "WRITER" }] }) as never,
    );
    expect(await maybeAutoMergePr("pr-am-1")).toEqual({ fired: true, sha: "auto0001" });
  });

  it("stays armed (no throw) when the merge conflicts", async () => {
    vi.mocked(executePullMerge).mockResolvedValue({ status: "conflict" });
    const result = await maybeAutoMergePr("pr-am-1");
    expect(result).toEqual({ fired: false, reason: "conflict" });
    // The intent is not cleared — no pullRequest.update from this path.
    expect(vi.mocked(prisma.pullRequest.update)).not.toHaveBeenCalled();
  });
});

// ─── CI-completion fan-out ────────────────────────────────────────────────────

describe("maybeAutoMergeForCommit", () => {
  it("evaluates only armed PRs whose CURRENT head is the completed commit", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { id: "pr-am-1", fromBranch: "feature" },
      { id: "pr-am-2", fromBranch: "other" },
    ] as never);
    // `feature` is at the completed commit; `other` has moved past it.
    vi.mocked(resolveBranchSha).mockImplementation((_key: string, branch: string) =>
      Promise.resolve(branch === "feature" ? "head1234" : "newer567"),
    );

    await maybeAutoMergeForCommit("repo-am-1", "head1234");

    expect(vi.mocked(executePullMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executePullMerge)).toHaveBeenCalledWith(
      expect.objectContaining({ pr: expect.objectContaining({ id: "pr-am-1" }) }),
    );
  });

  it("no-ops when nothing is armed", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
    await maybeAutoMergeForCommit("repo-am-1", "head1234");
    expect(vi.mocked(prisma.repo.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(executePullMerge)).not.toHaveBeenCalled();
  });
});
