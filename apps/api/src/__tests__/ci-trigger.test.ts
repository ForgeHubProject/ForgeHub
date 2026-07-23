import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

vi.mock("../prisma.js", () => ({
  prisma: {
    workflowRun: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    checkRun: { update: vi.fn().mockResolvedValue({}) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from "../prisma.js";
import {
  triggerWorkflows,
  triggerWorkflowsForPush,
  triggerWorkflowsForPrSync,
} from "../ci/trigger.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";

let idSeq = 0;
let current: TestRepo | null = null;

/** A fresh bare repo whose tree holds exactly `files` at one commit. */
async function scenario(files: Record<string, string>): Promise<{ storageKey: string; sha: string }> {
  const r = await createTestRepo(`test/ci-trig-${idSeq++}.git`);
  current = r;
  const sha = await makeCommit(r.workDir, files, "workflow commit");
  return { storageKey: r.storageKey, sha };
}

afterEach(async () => {
  await current?.cleanup();
  current = null;
  delete process.env["FORGEHUB_CI"];
});

beforeEach(() => {
  vi.clearAllMocks();
  idSeq++;
  vi.mocked(prisma.workflowRun.create).mockImplementation(((args: { data: Record<string, unknown> }) => {
    const create = (args.data.checkRuns as { create?: unknown } | undefined)?.create ?? [];
    const arr = Array.isArray(create) ? create : [create];
    return Promise.resolve({
      id: `run-${idSeq++}`,
      checkRuns: arr.map((c, i) => ({ id: `chk-${i}`, jobId: (c as { jobId: string }).jobId })),
    });
  }) as never);
  vi.mocked(prisma.workflowRun.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.checkRun.update).mockResolvedValue({} as never);
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
});

const PUSH_WF = ["on: [push]", "jobs:", "  build:", "    name: Build", "    steps:", "      - run: echo hi"].join("\n");
const PR_WF = ["on: [pull_request]", "jobs:", "  a:", "    steps:", "      - run: echo a"].join("\n");

describe("FORGEHUB_CI gate", () => {
  it("records nothing at all when FORGEHUB_CI is unset", async () => {
    delete process.env["FORGEHUB_CI"];
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/ci.yml": PUSH_WF });
    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "push", ref: "main" });
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
  });
});

describe("with FORGEHUB_CI=1", () => {
  beforeEach(() => { process.env["FORGEHUB_CI"] = "1"; });

  it("creates a queued run for a matching push workflow", async () => {
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/ci.yml": PUSH_WF });
    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "push", ref: "main" });

    expect(prisma.workflowRun.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.workflowRun.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.trigger).toBe("push");
    expect(data.status).toBe("queued");
    expect(data.workflowName).toBe("ci"); // no top-level `name:` → basename fallback
    expect(data.workflowPath).toBe(".forgehub/workflows/ci.yml");
    const checkCreate = (data.checkRuns as { create: Array<{ jobId: string }> }).create;
    expect(checkCreate).toHaveLength(1);
    expect(checkCreate[0].jobId).toBe("build");
  });

  it("does nothing when the workflows directory is absent (→ no runs)", async () => {
    const { storageKey, sha } = await scenario({ "readme.txt": "no workflows here" });
    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "push", ref: "main" });
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("skips a workflow that does not subscribe to the event", async () => {
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/pr-only.yml": PR_WF });

    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "push", ref: "main" });
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();

    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "pull_request", ref: "feature", prId: "pr-1" });
    expect(prisma.workflowRun.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.workflowRun.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.trigger).toBe("pull_request");
    expect(data.prId).toBe("pr-1");
  });

  it("records a FAILED run whose log holds the parse error for invalid YAML", async () => {
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/broken.yml": 'name: "unterminated\non: [push]\n' });
    await triggerWorkflows({ repoId: "repo-1", storageKey, commitSha: sha, event: "push", ref: "main" });

    expect(prisma.workflowRun.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.workflowRun.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("completed");
    expect(data.conclusion).toBe("failure");

    const updateCall = vi.mocked(prisma.checkRun.update).mock.calls.at(-1)![0] as { data: { logPath?: string } };
    const log = await readFile(updateCall.data.logPath!, "utf8");
    expect(log).toMatch(/could not be parsed/i);
    expect(log).toMatch(/YAML parse error/i);
  });

  it("triggerWorkflowsForPush fans out over changed branches", async () => {
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/ci.yml": PUSH_WF });
    await triggerWorkflowsForPush("repo-1", storageKey, [{ branch: "main", oldSha: "0".repeat(40), newSha: sha }]);
    expect(prisma.workflowRun.create).toHaveBeenCalledTimes(1);
  });

  it("triggerWorkflowsForPrSync enqueues pull_request runs for open PRs on changed branches", async () => {
    const { storageKey, sha } = await scenario({ ".forgehub/workflows/pr.yml": PR_WF });
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([{ id: "pr-9", fromBranch: "feature" }] as never);
    await triggerWorkflowsForPrSync("repo-1", storageKey, [{ branch: "feature", oldSha: "0".repeat(40), newSha: sha }]);
    expect(prisma.workflowRun.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.workflowRun.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.trigger).toBe("pull_request");
    expect(data.prId).toBe("pr-9");
  });
});
