import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import {
  bareRepoPathFromKey,
  ciLogPath,
  ciRunDir,
  ciWorkspaceDir,
  ensureCiDir,
  removeCiWorkspace,
} from "../git-storage.js";
import { prisma } from "../prisma.js";
import { parseWorkflow, defaultWorkflowName, type WorkflowStep } from "./workflows.js";
import { git } from "../git-utils.js";

/**
 * ⚠️  SECURITY — READ BEFORE TOUCHING THIS FILE  ⚠️
 * ---------------------------------------------------------------------------
 * This runner executes REPO-AUTHOR-CONTROLLED SHELL COMMANDS directly on the
 * host, in the same OS user as the API process, with only a per-job timeout and
 * a throwaway clone directory for isolation. There is NO container / VM / user
 * sandbox in v0. Anyone who can push a `.forgehub/workflows/*.yml` to a repo can
 * run arbitrary code on this box.
 *
 * Because of that, the runner is HARD-OFF unless the operator sets `FORGEHUB_CI=1`.
 * The intended deployment is a SINGLE-TENANT, SELF-HOSTED instance where every
 * pusher is already trusted with shell access. Multi-tenant isolation (containers,
 * ephemeral runners, network egress control) is an explicit later stage of the
 * epic (#86) and MUST land before this is safe for untrusted authors.
 *
 * When `FORGEHUB_CI` is unset the trigger layer records NOTHING — no runs, no
 * parsing — so a disabled instance behaves as if this feature does not exist.
 * ---------------------------------------------------------------------------
 */

export function isCiEnabled(): boolean {
  return process.env["FORGEHUB_CI"] === "1";
}

/** Per-job wall-clock budget in ms (CI_JOB_TIMEOUT seconds; default 600s). */
export function jobTimeoutMs(): number {
  const secs = Number(process.env["CI_JOB_TIMEOUT"]);
  return Number.isFinite(secs) && secs > 0 ? Math.floor(secs * 1000) : 600_000;
}

// Timeout for the clone/checkout of the workspace (separate from the job budget).
const CLONE_TIMEOUT_MS = 120_000;

// ─── In-process queue (one job at a time, v0) ──────────────────────────────────

const queue: string[] = [];
let processing = false;
let idleResolvers: Array<() => void> = [];

/** Resolves once the queue has drained and nothing is executing. Test seam. */
export function whenCiIdle(): Promise<void> {
  if (!processing && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleResolvers.push(resolve));
}

/** Enqueue a WorkflowRun for execution and kick the worker (idempotent kick). */
export function enqueueRun(runId: string): void {
  queue.push(runId);
  void pump();
}

async function pump(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const runId = queue.shift()!;
      try {
        await executeRun(runId);
      } catch (err) {
        // Never let one run wedge the queue; mark it failed defensively.
        console.error(`[ci-runner] run ${runId} threw`, err);
        await failRun(runId).catch(() => {});
      }
    }
  } finally {
    processing = false;
    const waiters = idleResolvers;
    idleResolvers = [];
    for (const w of waiters) w();
  }
}

async function failRun(runId: string): Promise<void> {
  await prisma.workflowRun.update({
    where: { id: runId },
    data: { status: "completed", conclusion: "failure", completedAt: new Date() },
  });
}

// ─── Run execution ─────────────────────────────────────────────────────────────

async function executeRun(runId: string): Promise<void> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: { checkRuns: true, repo: { select: { storageKey: true } } },
  });
  if (!run) return;
  const storageKey = run.repo.storageKey;
  if (!storageKey) {
    await failRun(runId);
    return;
  }

  await prisma.workflowRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });

  // Stable order: CheckRuns were created in job order; ids are monotonic cuids.
  const checks = [...run.checkRuns].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let anyFailed = false;
  for (const check of checks) {
    const failed = await executeCheck(
      { id: run.id, commitSha: run.commitSha, workflowPath: run.workflowPath, storageKey },
      { id: check.id, jobId: check.jobId, jobName: check.jobName },
    );
    if (failed) anyFailed = true;
  }

  await prisma.workflowRun.update({
    where: { id: runId },
    data: {
      status: "completed",
      conclusion: anyFailed ? "failure" : "success",
      completedAt: new Date(),
    },
  });
}

type RunCtx = { id: string; commitSha: string; workflowPath: string; storageKey: string };
type CheckCtx = { id: string; jobId: string; jobName: string };

/** Execute one job (CheckRun). Returns true if the job failed. */
async function executeCheck(run: RunCtx, check: CheckCtx): Promise<boolean> {
  const logPath = ciLogPath(run.storageKey, run.id, check.jobId);
  await ensureCiDir(ciRunDir(run.storageKey, run.id));

  await prisma.checkRun.update({
    where: { id: check.id },
    data: { status: "running", startedAt: new Date(), logPath },
  });

  const log = createWriteStream(logPath, { flags: "w" });
  const workspace = ciWorkspaceDir(run.id, check.jobId);
  let conclusion: "success" | "failure" = "success";

  try {
    write(log, `# Job: ${check.jobName}  (${check.jobId})\n`);
    write(log, `# Commit: ${run.commitSha}\n`);

    // Re-read the workflow at the triggering commit — it is immutable there, so
    // there is no need to denormalize shell commands into the database.
    const steps = await loadJobSteps(run, check.jobId, log);
    if (steps === null) {
      conclusion = "failure";
    } else {
      const cloned = await cloneCommit(run.storageKey, run.commitSha, workspace, log);
      if (!cloned) {
        conclusion = "failure";
      } else {
        conclusion = await runSteps(steps, workspace, log);
      }
    }
  } catch (err) {
    write(log, `\n[runner] internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    conclusion = "failure";
  } finally {
    await removeCiWorkspace(workspace).catch(() => {});
    await endStream(log);
  }

  await prisma.checkRun.update({
    where: { id: check.id },
    data: { status: "completed", conclusion, completedAt: new Date(), logPath },
  });
  return conclusion === "failure";
}

/** Read + parse the workflow file at the commit and return the job's steps (null on error, logged). */
async function loadJobSteps(run: RunCtx, jobId: string, log: WriteStream): Promise<WorkflowStep[] | null> {
  let content: string;
  try {
    content = await git(run.storageKey, ["show", `${run.commitSha}:${run.workflowPath}`]);
  } catch {
    write(log, `\n[runner] could not read workflow ${run.workflowPath} at ${run.commitSha}\n`);
    return null;
  }
  const parsed = parseWorkflow(content, defaultWorkflowName(run.workflowPath));
  if (!parsed.ok) {
    write(log, `\n[runner] workflow no longer parses: ${parsed.error}\n`);
    return null;
  }
  const job = parsed.workflow.jobs.find((j) => j.id === jobId);
  if (!job) {
    write(log, `\n[runner] job '${jobId}' not found in workflow\n`);
    return null;
  }
  return job.steps;
}

/** Fresh clone of `sha` into `workspace` (detached checkout). Returns success. */
async function cloneCommit(storageKey: string, sha: string, workspace: string, log: WriteStream): Promise<boolean> {
  const barePath = bareRepoPathFromKey(storageKey);
  await ensureCiDir(path.dirname(workspace));
  await removeCiWorkspace(workspace).catch(() => {});

  const clone = await runProcess("git", ["clone", "--quiet", barePath, workspace], process.cwd(), CLONE_TIMEOUT_MS, log);
  if (clone.code !== 0) {
    write(log, `\n[runner] clone failed (exit ${clone.code})\n`);
    return false;
  }
  const checkout = await runProcess("git", ["-C", workspace, "checkout", "--quiet", "--detach", sha], process.cwd(), CLONE_TIMEOUT_MS, log);
  if (checkout.code !== 0) {
    write(log, `\n[runner] could not check out ${sha} (exit ${checkout.code})\n`);
    return false;
  }
  return true;
}

/**
 * Run the job's steps in order, stopping on the first failure. The per-JOB budget
 * (jobTimeoutMs) is shared across steps: when it expires the running step's whole
 * process group is killed and the job fails with a timeout note.
 */
async function runSteps(steps: WorkflowStep[], workspace: string, log: WriteStream): Promise<"success" | "failure"> {
  const deadline = Date.now() + jobTimeoutMs();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = step.name ?? `Step ${i + 1}`;
    write(log, `\n=== ${label} ===\n$ ${step.run}\n`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      write(log, `\n[runner] job timed out before this step — killed.\n`);
      return "failure";
    }

    const res = await runProcess("sh", ["-c", step.run], workspace, remaining, log);
    if (res.timedOut) {
      write(log, `\n[runner] job exceeded CI_JOB_TIMEOUT — process group killed.\n`);
      return "failure";
    }
    if (res.code !== 0) {
      write(log, `\n[runner] step exited with code ${res.code}\n`);
      return "failure";
    }
  }
  return "success";
}

// ─── Low-level process runner ──────────────────────────────────────────────────

type ProcResult = { code: number | null; timedOut: boolean };

/**
 * Spawn a command in its own process group, stream stdout+stderr interleaved into
 * `log`, and enforce `timeoutMs` by SIGKILL-ing the whole group on expiry.
 */
function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  log: WriteStream,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      write(log, `\n[runner] failed to spawn ${command}: ${err instanceof Error ? err.message : String(err)}\n`);
      resolve({ code: 1, timedOut: false });
      return;
    }

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    const onData = (chunk: Buffer) => log.write(chunk);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      write(log, `\n[runner] process error: ${err.message}\n`);
      resolve({ code: 1, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

/** Kill an entire detached process group by its leader pid (best-effort). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ─── Stream helpers ────────────────────────────────────────────────────────────

function write(log: WriteStream, s: string): void {
  log.write(s);
}

function endStream(log: WriteStream): Promise<void> {
  return new Promise((resolve) => log.end(resolve));
}
