import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// The runner touches only these two prisma models. Everything else is real:
// real git clone of a real bare repo, real `sh -c` step execution, real log files.
vi.mock("../prisma.js", () => ({
  prisma: {
    workflowRun: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    checkRun: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { prisma } from "../prisma.js";
import { cancelRun, currentRunId, enqueueRun, whenCiIdle } from "../ci/runner.js";
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
  vi.mocked(prisma.workflowRun.updateMany).mockResolvedValue({} as never);
  vi.mocked(prisma.checkRun.update).mockResolvedValue({} as never);
  vi.mocked(prisma.checkRun.updateMany).mockResolvedValue({} as never);
});

/** Poll `pred` until true or a timeout — for waiting on the async runner's state. */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

// ─── env maps (v1) ───────────────────────────────────────────────────────────────

describe("runner env maps", () => {
  it("merges workflow-level and job-level env into each step, job overrides workflow", async () => {
    const { runConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "env:",
        "  GREETING: hello_wf",
        "  SHARED: from_wf",
        "jobs:",
        "  build:",
        "    env:",
        "      SHARED: from_job",
        "    steps:",
        '      - run: echo "G=$GREETING S=$SHARED"',
      ].join("\n"),
      [{ id: "chk-build", jobId: "build", jobName: "build" }],
    );
    expect(runConclusion).toBe("success");
    const log = logByCheck.get("chk-build")!;
    expect(log).toContain("G=hello_wf");
    expect(log).toContain("S=from_job"); // job-level wins over workflow-level
  });
});

// ─── re-run (fresh execution, own logs) ──────────────────────────────────────────

describe("runner re-run", () => {
  it("a second run of the SAME commit executes independently with its own log", async () => {
    // One commit (immutable sha) executed by two separate runs — the essence of a
    // re-run: change nothing, run again, each with its own fresh log.
    const commitSha = await makeCommit(
      repo.workDir,
      { ".forgehub/workflows/ci.yml": ["on: [push]", "jobs:", "  build:", "    steps:", "      - run: echo RERUN_OK"].join("\n") },
      "add workflow once",
    );

    async function execute(runId: string, checkId: string): Promise<string> {
      vi.mocked(prisma.workflowRun.findUnique).mockResolvedValue({
        id: runId, commitSha, workflowPath: ".forgehub/workflows/ci.yml",
        repo: { storageKey: repo.storageKey },
        checkRuns: [{ id: checkId, jobId: "build", jobName: "build" }],
      } as never);
      enqueueRun(runId);
      await whenCiIdle();
      const call = vi
        .mocked(prisma.checkRun.update)
        .mock.calls.map((c) => c[0] as { where: { id: string }; data: { logPath?: string } })
        .find((c) => c.where.id === checkId && typeof c.data.logPath === "string");
      return await readFile(call!.data.logPath!, "utf8");
    }

    const firstLog = await execute("run-orig", "chk-orig");
    const secondLog = await execute("run-rerun", "chk-rerun");
    expect(firstLog).toContain("RERUN_OK");
    expect(secondLog).toContain("RERUN_OK");
  }, 15_000);
});

// ─── cancel ──────────────────────────────────────────────────────────────────────

describe("runner cancel", () => {
  it("cancels a RUNNING job: kills the process fast, later jobs skipped", async () => {
    const commitSha = await makeCommit(
      repo.workDir,
      {
        ".forgehub/workflows/ci.yml": [
          "on: [push]",
          "jobs:",
          "  slow:",
          "    steps:",
          "      - run: sleep 30",
          "  after:",
          "    steps:",
          "      - run: echo AFTER_RAN",
        ].join("\n"),
      },
      "add slow workflow",
    );
    const runId = "run-cancel-running";
    // Check ids drive execution order (sorted): "chk-1slow" runs before "chk-2after".
    vi.mocked(prisma.workflowRun.findUnique).mockResolvedValue({
      id: runId,
      commitSha,
      workflowPath: ".forgehub/workflows/ci.yml",
      repo: { storageKey: repo.storageKey },
      checkRuns: [
        { id: "chk-1slow", jobId: "slow", jobName: "slow" },
        { id: "chk-2after", jobId: "after", jobName: "after" },
      ],
    } as never);

    enqueueRun(runId);
    await waitFor(() => currentRunId() === runId);
    // Let the clone finish and the sleep step actually spawn, then cancel it.
    await new Promise((r) => setTimeout(r, 400));
    await cancelRun(runId);
    await whenCiIdle(); // must resolve well under the 30s sleep → proves the kill

    // The run was finalized as cancelled.
    const runUpdate = vi
      .mocked(prisma.workflowRun.update)
      .mock.calls.map((c) => c[0] as { data: Record<string, unknown> })
      .find((u) => u.data.status === "completed");
    expect(runUpdate?.data.conclusion).toBe("cancelled");

    // The killed job's check was marked cancelled; the later job never started.
    const slowUpdate = vi
      .mocked(prisma.checkRun.update)
      .mock.calls.map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> })
      .find((u) => u.where.id === "chk-1slow" && u.data.status === "completed");
    expect(slowUpdate?.data.conclusion).toBe("cancelled");
    const afterStarted = vi
      .mocked(prisma.checkRun.update)
      .mock.calls.some((c) => (c[0] as { where: { id: string } }).where.id === "chk-2after");
    expect(afterStarted).toBe(false); // later job skipped entirely
    // Remaining jobs finalized via updateMany.
    expect(prisma.checkRun.updateMany).toHaveBeenCalled();
  }, 15_000);

  it("cancels a QUEUED run before it starts (never executes)", async () => {
    const commitSha = await makeCommit(
      repo.workDir,
      {
        ".forgehub/workflows/ci.yml": ["on: [push]", "jobs:", "  slow:", "    steps:", "      - run: sleep 30"].join("\n"),
        ".forgehub/workflows/q.yml": ["on: [push]", "jobs:", "  q:", "    steps:", "      - run: echo QUEUED_RAN"].join("\n"),
      },
      "add two workflows",
    );
    const RUNNING = "run-busy";
    const QUEUED = "run-queued";
    vi.mocked(prisma.workflowRun.findUnique).mockImplementation(((args: { where: { id: string } }) => {
      if (args.where.id === RUNNING) {
        return Promise.resolve({
          id: RUNNING, commitSha, workflowPath: ".forgehub/workflows/ci.yml",
          repo: { storageKey: repo.storageKey },
          checkRuns: [{ id: "chk-busy", jobId: "slow", jobName: "slow" }],
        });
      }
      return Promise.resolve({
        id: QUEUED, commitSha, workflowPath: ".forgehub/workflows/q.yml",
        repo: { storageKey: repo.storageKey },
        checkRuns: [{ id: "chk-q", jobId: "q", jobName: "q" }],
      });
    }) as never);

    enqueueRun(RUNNING); // occupies the single worker with a 30s sleep
    enqueueRun(QUEUED); // sits in the queue behind it
    await waitFor(() => currentRunId() === RUNNING);

    await cancelRun(QUEUED); // dequeued + finalized without ever executing
    await cancelRun(RUNNING); // kill the sleep so the worker drains
    await whenCiIdle();

    // The queued run was finalized as cancelled via updateMany, and its job never ran.
    const queuedFinalized = vi
      .mocked(prisma.workflowRun.updateMany)
      .mock.calls.some((c) => {
        const a = c[0] as { where: { id: string }; data: Record<string, unknown> };
        return a.where.id === QUEUED && a.data.conclusion === "cancelled";
      });
    expect(queuedFinalized).toBe(true);
    const queuedStarted = vi
      .mocked(prisma.checkRun.update)
      .mock.calls.some((c) => (c[0] as { where: { id: string } }).where.id === "chk-q");
    expect(queuedStarted).toBe(false); // queued job never started
  }, 15_000);
});
