import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    repo: { findUnique: vi.fn() },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestReviewerRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../notifications-service.js", () => ({
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../timeline-service.js", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

// Only the two git reads are stubbed — the CODEOWNERS parser and matcher run for
// real, so these tests cover the wiring AND the grammar end to end.
vi.mock("../git-utils.js", () => ({
  readFileAtBranch: vi.fn().mockResolvedValue(null),
  getMergeBaseFileList: vi.fn().mockResolvedValue([]),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { notifyUser } from "../notifications-service.js";
import { recordEvent } from "../timeline-service.js";
import { getMergeBaseFileList, readFileAtBranch } from "../git-utils.js";
import { applyCodeownersReviewers, syncCodeownersReviewersForPush } from "../codeowners-service.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-repo-owner";
const AUTHOR_ID = "user-author";
const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

const REPO = {
  id: "repo-1",
  storageKey: "alice/my-repo.git",
  ownerId: OWNER_ID,
  collaborators: [{ userId: ALICE_ID }, { userId: BOB_ID }, { userId: AUTHOR_ID }],
};

const PR = {
  id: "pr-1",
  number: 7,
  title: "Add feature",
  fromBranch: "feature",
  toBranch: "main",
  authorId: AUTHOR_ID,
};

/** Point CODEOWNERS at `content` and the PR's diff at `paths`. */
function scenario(content: string | null, paths: string[]) {
  vi.mocked(readFileAtBranch).mockResolvedValue(content);
  vi.mocked(getMergeBaseFileList).mockResolvedValue(paths.map((path) => ({
    path, additions: 1, deletions: 0, binary: false, status: "modified" as const,
  })));
}

/** The users the handle lookup should resolve. */
function users(rows: Array<{ id: string; handle: string }>) {
  vi.mocked(prisma.user.findMany).mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.pullRequestReviewerRequest.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.pullRequestReviewerRequest.create).mockResolvedValue({} as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
  scenario(null, []);
});

// ─── applyCodeownersReviewers ─────────────────────────────────────────────────

describe("applyCodeownersReviewers", () => {
  it("requests the matching owner and fires REVIEW_REQUESTED", async () => {
    scenario("apps/api/ @alice\n", ["apps/api/src/server.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);

    const requested = await applyCodeownersReviewers(REPO, PR, AUTHOR_ID);

    expect(requested).toEqual(["alice"]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).toHaveBeenCalledWith({
      data: { pullRequestId: "pr-1", userId: ALICE_ID, requestedById: AUTHOR_ID, viaCodeowners: true },
    });
    expect(vi.mocked(notifyUser)).toHaveBeenCalledWith(
      ALICE_ID,
      expect.objectContaining({ reason: "REVIEW_REQUESTED", subjectId: "pr-1", repoId: "repo-1" }),
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "review_requested", data: { reviewer: "alice", viaCodeowners: true } }),
    );
  });

  it("reads CODEOWNERS from the PR's base branch, not its head", async () => {
    scenario("* @alice\n", ["a.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);
    await applyCodeownersReviewers(REPO, PR, AUTHOR_ID);
    expect(vi.mocked(readFileAtBranch)).toHaveBeenCalledWith(REPO.storageKey, "main", ".forgehub/CODEOWNERS");
  });

  it("never requests the PR author as their own reviewer", async () => {
    scenario("* @author\n", ["a.ts"]);
    users([{ id: AUTHOR_ID, handle: "author" }]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual([]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).not.toHaveBeenCalled();
  });

  it("never requests the acting user (a self-request the manual endpoint would reject)", async () => {
    scenario("* @alice\n", ["a.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);
    // alice pushed to someone else's PR — she is the actor, so no self-request.
    expect(await applyCodeownersReviewers(REPO, PR, ALICE_ID)).toEqual([]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).not.toHaveBeenCalled();
  });

  it("skips owners who are neither the repo owner nor a collaborator", async () => {
    scenario("* @stranger @alice\n", ["a.ts"]);
    users([{ id: "user-stranger", handle: "stranger" }, { id: ALICE_ID, handle: "alice" }]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual(["alice"]);
  });

  it("requests the repo owner even without a collaborator row", async () => {
    scenario("* @rowner\n", ["a.ts"]);
    users([{ id: OWNER_ID, handle: "rowner" }]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual(["rowner"]);
  });

  it("skips handles with no matching user", async () => {
    scenario("* @ghost\n", ["a.ts"]);
    users([]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual([]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).not.toHaveBeenCalled();
  });

  it("leaves an existing request row alone — withdrawn requests are never revived", async () => {
    scenario("* @alice\n", ["a.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);
    vi.mocked(prisma.pullRequestReviewerRequest.findUnique).mockResolvedValue(
      { id: "req-1", dismissedAt: new Date(), fulfilledAt: null } as never,
    );

    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual([]);
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).not.toHaveBeenCalled();
    expect(vi.mocked(notifyUser)).not.toHaveBeenCalled();
  });

  it("swallows a lost race on the (PR, reviewer) unique constraint", async () => {
    scenario("* @alice\n", ["a.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);
    vi.mocked(prisma.pullRequestReviewerRequest.create).mockRejectedValue(new Error("unique constraint"));

    await expect(applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).resolves.toEqual([]);
    expect(vi.mocked(notifyUser)).not.toHaveBeenCalled();
  });

  it("does nothing when the repo has no CODEOWNERS", async () => {
    scenario(null, ["a.ts"]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual([]);
    expect(vi.mocked(getMergeBaseFileList)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.user.findMany)).not.toHaveBeenCalled();
  });

  it("does nothing when no changed file matches a rule", async () => {
    scenario("docs/ @alice\n", ["apps/api/src/server.ts"]);
    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual([]);
    expect(vi.mocked(prisma.user.findMany)).not.toHaveBeenCalled();
  });

  it("applies last-match-wins across the PR's changed files", async () => {
    scenario(
      ["* @rowner", "apps/api/ @alice", "apps/api/generated/ @bob", "!apps/api/generated/vendor/"].join("\n"),
      ["apps/api/src/a.ts", "apps/api/generated/b.ts", "apps/api/generated/vendor/c.ts"],
    );
    users([{ id: ALICE_ID, handle: "alice" }, { id: BOB_ID, handle: "bob" }]);

    expect(await applyCodeownersReviewers(REPO, PR, AUTHOR_ID)).toEqual(["alice", "bob"]);
    // `rowner` is never even looked up: every changed path is claimed by a lower
    // rule, and the negated rule leaves the vendor file unowned rather than
    // falling back to the `*` rule above it.
    expect(vi.mocked(prisma.user.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { handle: { in: ["alice", "bob"] } } }),
    );
  });
});

// ─── syncCodeownersReviewersForPush ───────────────────────────────────────────

describe("syncCodeownersReviewersForPush", () => {
  beforeEach(() => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(REPO as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([PR] as never);
  });

  it("re-runs the match for open PRs whose head branch moved", async () => {
    scenario("* @alice\n", ["a.ts"]);
    users([{ id: ALICE_ID, handle: "alice" }]);

    await syncCodeownersReviewersForPush("repo-1", AUTHOR_ID, [
      { branch: "feature" }, { branch: "feature" }, { branch: "main" },
    ]);

    expect(vi.mocked(prisma.pullRequest.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ repoId: "repo-1", state: "OPEN", fromBranch: { in: ["feature", "main"] } }),
      }),
    );
    expect(vi.mocked(prisma.pullRequestReviewerRequest.create)).toHaveBeenCalledTimes(1);
  });

  it("no-ops for an empty change set", async () => {
    await syncCodeownersReviewersForPush("repo-1", AUTHOR_ID, []);
    expect(vi.mocked(prisma.repo.findUnique)).not.toHaveBeenCalled();
  });

  it("no-ops when the repo has no git storage", async () => {
    vi.mocked(prisma.repo.findUnique).mockResolvedValue({ ...REPO, storageKey: null } as never);
    await syncCodeownersReviewersForPush("repo-1", AUTHOR_ID, [{ branch: "feature" }]);
    expect(vi.mocked(prisma.pullRequest.findMany)).not.toHaveBeenCalled();
  });
});
