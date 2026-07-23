import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// The runner touches only these two prisma models. Everything else is real:
// real git clone of a real bare repo, real `sh -c` step execution, real log files.
vi.mock("../prisma.js", () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    checkRun: { update: vi.fn().mockResolvedValue({}) },
  },
}));

import { prisma } from "../prisma.js";
import { enqueueRun, whenCiIdle } from "../ci/runner.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";

type CheckFixture = { id: string; jobId: string; jobName: string };

let repo: TestRepo;
beforeAll(async () => {
  repo = await createTestRepo("test/ci-runner.git");
}, 30_000);
afterAll(async () => { await repo?.cleanup(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.workflowRun.update).mockResolvedValue({} as never);
  vi.mocked(prisma.checkRun.update).mockResolvedValue({} as never);
});

/** Commit a workflow (+ a marker file) and execute the run against real git. */
async function runWorkflow(
  workflowYaml: string,
  checkRuns: CheckFixture[],
): Promise<{
  runConclusion: string | undefined;
  checkConclusion: Map<string, string>;
  logByCheck: Map<string, string>;
}> {
  const commitSha = await makeCommit(
    repo.workDir,
    { ".forgehub/workflows/ci.yml": workflowYaml, "marker.txt": "MARKER_CONTENT" },
    "add workflow",
  );

  const runId = `run-${Math.random().toString(36).slice(2)}`;
  vi.mocked(prisma.workflowRun.findUnique).mockResolvedValue({
    id: runId,
    commitSha,
    workflowPath: ".forgehub/workflows/ci.yml",
    repo: { storageKey: repo.storageKey },
    checkRuns,
  } as never);

  enqueueRun(runId);
  await whenCiIdle();

  const checkConclusion = new Map<string, string>();
  const logByCheck = new Map<string, string>();
  const logPathByCheck = new Map<string, string>();
  for (const call of vi.mocked(prisma.checkRun.update).mock.calls) {
    const arg = call[0] as { where: { id: string }; data: Record<string, unknown> };
    if (typeof arg.data.logPath === "string") logPathByCheck.set(arg.where.id, arg.data.logPath);
    if (arg.data.status === "completed") checkConclusion.set(arg.where.id, arg.data.conclusion as string);
  }
  for (const [id, p] of logPathByCheck) {
    logByCheck.set(id, await readFile(p, "utf8").catch(() => ""));
  }

  const runUpdates = vi.mocked(prisma.workflowRun.update).mock.calls.map((c) => c[0] as { data: Record<string, unknown> });
  const completed = runUpdates.find((u) => u.data.status === "completed");
  return { runConclusion: completed?.data.conclusion as string | undefined, checkConclusion, logByCheck };
}

describe("runner end-to-end", () => {
  it("runs an echo workflow to success and captures step output", async () => {
    const { runConclusion, checkConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  build:",
        "    name: Build",
        "    steps:",
        "      - name: Say hello",
        "        run: echo HELLO_FROM_CI",
        "      - name: Read checkout",
        "        run: cat marker.txt",
      ].join("\n"),
      [{ id: "chk-build", jobId: "build", jobName: "Build" }],
    );

    expect(runConclusion).toBe("success");
    expect(checkConclusion.get("chk-build")).toBe("success");
    const log = logByCheck.get("chk-build")!;
    expect(log).toContain("HELLO_FROM_CI");
    expect(log).toContain("=== Say hello ===");
    // Proves the commit was actually checked out into the workspace.
    expect(log).toContain("MARKER_CONTENT");
  });

  it("fails on the first failing step and preserves earlier output, skipping later steps", async () => {
    const { runConclusion, checkConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: echo FIRST_STEP_OUTPUT",
        "      - run: exit 3",
        "      - run: echo SHOULD_NOT_APPEAR",
      ].join("\n"),
      [{ id: "chk-test", jobId: "test", jobName: "test" }],
    );

    expect(runConclusion).toBe("failure");
    expect(checkConclusion.get("chk-test")).toBe("failure");
    const log = logByCheck.get("chk-test")!;
    expect(log).toContain("FIRST_STEP_OUTPUT"); // earlier output preserved
    expect(log).toContain("exited with code 3");
    expect(log).not.toContain("SHOULD_NOT_APPEAR"); // later step never ran
  });

  it("runs multiple jobs; the run fails if any job fails", async () => {
    const { runConclusion, checkConclusion } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  ok:",
        "    steps:",
        "      - run: echo good",
        "  bad:",
        "    steps:",
        "      - run: exit 1",
      ].join("\n"),
      [
        { id: "chk-ok", jobId: "ok", jobName: "ok" },
        { id: "chk-bad", jobId: "bad", jobName: "bad" },
      ],
    );

    expect(checkConclusion.get("chk-ok")).toBe("success");
    expect(checkConclusion.get("chk-bad")).toBe("failure");
    expect(runConclusion).toBe("failure");
  });

  it("times out a long step via CI_JOB_TIMEOUT and kills the process group", async () => {
    process.env["CI_JOB_TIMEOUT"] = "1"; // 1 second budget
    try {
      const { runConclusion, checkConclusion, logByCheck } = await runWorkflow(
        ["on: [push]", "jobs:", "  slow:", "    steps:", "      - run: sleep 30"].join("\n"),
        [{ id: "chk-slow", jobId: "slow", jobName: "slow" }],
      );
      expect(runConclusion).toBe("failure");
      expect(checkConclusion.get("chk-slow")).toBe("failure");
      expect(logByCheck.get("chk-slow")).toMatch(/CI_JOB_TIMEOUT/);
    } finally {
      delete process.env["CI_JOB_TIMEOUT"];
    }
  }, 15_000);
});
