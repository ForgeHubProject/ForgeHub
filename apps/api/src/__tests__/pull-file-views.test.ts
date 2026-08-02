import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    pullRequest: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pullRequestFileView: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("../git-utils.js", () => ({
  listChangedPaths: vi.fn().mockResolvedValue([]),
}));

// push-events pulls in the webhook/CI fan-out; only ZERO_SHA is needed here.
vi.mock("../push-events.js", () => ({
  emitPushEvents: vi.fn(),
  ZERO_SHA: "0".repeat(40),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { listChangedPaths } from "../git-utils.js";
import { resetViewedFilesForPush } from "../pull-file-views.js";

const ZERO = "0".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
    { id: "pr-v-1", fromBranch: "feature" },
  ] as never);
  vi.mocked(listChangedPaths).mockResolvedValue(["src/a.ts", "docs/b.md"]);
});

describe("resetViewedFilesForPush", () => {
  it("deletes viewed rows for exactly the files the push changed, scoped to the PR", async () => {
    await resetViewedFilesForPush("repo-v-1", "alice/my-repo.git", [
      { branch: "feature", oldSha: "old11111", newSha: "new22222" },
    ]);

    expect(vi.mocked(listChangedPaths)).toHaveBeenCalledWith("alice/my-repo.git", "old11111", "new22222");
    expect(vi.mocked(prisma.pullRequestFileView.deleteMany)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.pullRequestFileView.deleteMany)).toHaveBeenCalledWith({
      where: { pullRequestId: "pr-v-1", filePath: { in: ["src/a.ts", "docs/b.md"] } },
    });
  });

  it("only considers OPEN PRs whose HEAD branch moved", async () => {
    await resetViewedFilesForPush("repo-v-1", "alice/my-repo.git", [
      { branch: "feature", oldSha: "old11111", newSha: "new22222" },
    ]);
    expect(vi.mocked(prisma.pullRequest.findMany)).toHaveBeenCalledWith({
      where: { repoId: "repo-v-1", state: "OPEN", fromBranch: { in: ["feature"] } },
      select: { id: true, fromBranch: true },
    });
  });

  it("resets EVERYTHING for the PR when the branch was (re)created — no diffable range", async () => {
    await resetViewedFilesForPush("repo-v-1", "alice/my-repo.git", [
      { branch: "feature", oldSha: ZERO, newSha: "new22222" },
    ]);
    expect(vi.mocked(listChangedPaths)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.pullRequestFileView.deleteMany)).toHaveBeenCalledWith({
      where: { pullRequestId: "pr-v-1" },
    });
  });

  it("no-ops when the push changed no files", async () => {
    vi.mocked(listChangedPaths).mockResolvedValue([]);
    await resetViewedFilesForPush("repo-v-1", "alice/my-repo.git", [
      { branch: "feature", oldSha: "old11111", newSha: "new22222" },
    ]);
    expect(vi.mocked(prisma.pullRequestFileView.deleteMany)).not.toHaveBeenCalled();
  });

  it("no-ops entirely on an empty changed set", async () => {
    await resetViewedFilesForPush("repo-v-1", "alice/my-repo.git", []);
    expect(vi.mocked(prisma.pullRequest.findMany)).not.toHaveBeenCalled();
  });
});
