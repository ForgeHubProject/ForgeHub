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
 *
 * CI v1 adds *containment*, NOT isolation: a per-job wall-clock budget
 * (CI_JOB_TIMEOUT) that SIGKILLs a runaway job's process group, an operator/writer
 * `cancel` that kills the in-flight job the same way, and run retention
 * (FORGEHUB_CI_RETENTION) that caps how much a repo's history can accumulate on
 * disk. These bound blast radius and resource use — they do NOT sandbox the code.
 * Container / VM / user isolation and network-egress control remain the explicit
 * later stage of #86 that MUST land before this is safe for untrusted authors.
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

// ─── Cancellation state ────────────────────────────────────────────────────────
// A cancel is a two-part signal: (1) the run id joins `cancelRequested`, and
// (2) if that run is the one executing, its in-flight process group is killed.
// The executor consults `cancelRequested` between/inside jobs and finalizes the
// run + any unfinished jobs as `cancelled`. A queued run that is not yet active is
// simply pulled from the queue and finalized immediately — it never starts.

/** Run ids for which a cancel has been requested (consumed by the executor). */
const cancelRequested = new Set<string>();
/** The run currently executing — set synchronously by pump() before executeRun. */
let activeRunId: string | null = null;
/** The child process (step or clone) currently in flight for the active run. */
let activeChild: ReturnType<typeof spawn> | null = null;

/** Test/introspection seam: the run currently executing, or null when idle. */
export function currentRunId(): string | null {
  return activeRunId;
}

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
      activeRunId = runId; // synchronous: closes the queued-vs-running cancel race
      try {
        await executeRun(runId);
      } catch (err) {
        // Never let one run wedge the queue; mark it failed defensively.
        console.error(`[ci-runner] run ${runId} threw`, err);
        await failRun(runId).catch(() => {});
      } finally {
        activeRunId = null;
        activeChild = null;
        cancelRequested.delete(runId);
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

/**
 * Request cancellation of a run (writer-gated at the route). A QUEUED run is
 * pulled from the queue and finalized as `cancelled` at once — it never starts.
 * The RUNNING run has its in-flight process group killed; executeRun's loop then
 * sees the flag and finalizes the run + its unfinished jobs. Idempotent, and every
 * write is guarded (`status != completed`) so a run that finished in the meantime
 * is never clobbered. Cancelled counts as a non-success conclusion, so the
 * check-summary rollup buckets it as failing for branch protection (cancelled ≠ green).
 */
export async function cancelRun(runId: string): Promise<void> {
  cancelRequested.add(runId);

  const qIdx = queue.indexOf(runId);
  if (qIdx !== -1) queue.splice(qIdx, 1);

  if (activeRunId === runId) {
    // Running: kill the current step/clone. executeRun finalizes it as cancelled.
    killGroup(activeChild?.pid);
  } else {
    // Queued (now dequeued) or never enqueued → finalize immediately.
    await finalizeCancelled(runId);
    cancelRequested.delete(runId);
  }
}

/** Mark a run's not-yet-completed jobs `cancelled` (guarded against a completed race). */
async function markRemainingCancelled(runId: string): Promise<void> {
  await prisma.checkRun.updateMany({
    where: { workflowRunId: runId, status: { not: "completed" } },
    data: { status: "completed", conclusion: "cancelled", completedAt: new Date() },
  });
}

/** Finalize a whole run as cancelled: its unfinished jobs, then the run row. */
async function finalizeCancelled(runId: string): Promise<void> {
  await markRemainingCancelled(runId);
  await prisma.workflowRun.updateMany({
    where: { id: runId, status: { not: "completed" } },
    data: { status: "completed", conclusion: "cancelled", completedAt: new Date() },
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

  // Cancelled while still queued (or a cancel that raced the dequeue): never start.
  if (cancelRequested.has(runId)) {
    await finalizeCancelled(runId);
    return;
  }

  await prisma.workflowRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });

  // Stable order: CheckRuns were created in job order; ids are monotonic cuids.
  const checks = [...run.checkRuns].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let anyFailed = false;
  let cancelled = false;
  for (const check of checks) {
    if (cancelRequested.has(runId)) {
      cancelled = true;
      break;
    }
    const conclusion = await executeCheck(
      { id: run.id, commitSha: run.commitSha, workflowPath: run.workflowPath, storageKey },
      { id: check.id, jobId: check.jobId, jobName: check.jobName },
    );
    if (conclusion === "cancelled") {
      cancelled = true;
      break;
    }
    if (conclusion === "failure") anyFailed = true;
  }

  if (cancelled) {
    // Bucket any jobs that never ran (or the killed one, defensively) as cancelled.
    await markRemainingCancelled(runId);
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "completed", conclusion: "cancelled", completedAt: new Date() },
    });
    return;
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

type JobConclusion = "success" | "failure" | "cancelled";

/** Execute one job (CheckRun). Returns its conclusion. */
async function executeCheck(run: RunCtx, check: CheckCtx): Promise<JobConclusion> {
  const logPath = ciLogPath(run.storageKey, run.id, check.jobId);
  await ensureCiDir(ciRunDir(run.storageKey, run.id));

  await prisma.checkRun.update({
    where: { id: check.id },
    data: { status: "running", startedAt: new Date(), logPath },
  });

  const log = createWriteStream(logPath, { flags: "w" });
  const workspace = ciWorkspaceDir(run.id, check.jobId);
  let conclusion: JobConclusion = "success";

  try {
    write(log, `# Job: ${check.jobName}  (${check.jobId})\n`);
    write(log, `# Commit: ${run.commitSha}\n`);

    // Re-read the workflow at the triggering commit — it is immutable there, so
    // there is no need to denormalize shell commands / env into the database.
    const job = await loadJob(run, check.jobId, log);
    if (job === null) {
      conclusion = "failure";
    } else {
      const cloned = await cloneCommit(run.storageKey, run.commitSha, workspace, log);
      if (cancelRequested.has(run.id)) {
        write(log, `\n[runner] run cancelled.\n`);
        conclusion = "cancelled";
      } else if (!cloned) {
        conclusion = "failure";
      } else {
        conclusion = await runSteps(run.id, job.steps, job.env, workspace, log);
      }
    }
  } catch (err) {
    write(log, `\n[runner] internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    conclusion = cancelRequested.has(run.id) ? "cancelled" : "failure";
  } finally {
    await removeCiWorkspace(workspace).catch(() => {});
    await endStream(log);
  }

  await prisma.checkRun.update({
    where: { id: check.id },
    data: { status: "completed", conclusion, completedAt: new Date(), logPath },
  });
  return conclusion;
}

type LoadedJob = { steps: WorkflowStep[]; env: Record<string, string> };

/** Read + parse the workflow file at the commit and return the job's steps + merged env (null on error, logged). */
async function loadJob(run: RunCtx, jobId: string, log: WriteStream): Promise<LoadedJob | null> {
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
  return { steps: job.steps, env: job.env };
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
 * process group is killed and the job fails with a timeout note. A cancel likewise
 * kills the in-flight step (via cancelRun → killGroup) and returns "cancelled".
 * `env` is layered over the runner's own environment for every step.
 */
async function runSteps(
  runId: string,
  steps: WorkflowStep[],
  env: Record<string, string>,
  workspace: string,
  log: WriteStream,
): Promise<JobConclusion> {
  const deadline = Date.now() + jobTimeoutMs();
  for (let i = 0; i < steps.length; i++) {
    if (cancelRequested.has(runId)) {
      write(log, `\n[runner] run cancelled — remaining steps skipped.\n`);
      return "cancelled";
    }
    const step = steps[i];
    const label = step.name ?? `Step ${i + 1}`;
    write(log, `\n=== ${label} ===\n$ ${step.run}\n`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      write(log, `\n[runner] job timed out before this step — killed.\n`);
      return "failure";
    }

    const res = await runProcess("sh", ["-c", step.run], workspace, remaining, log, env);
    // A cancel kills the process group; distinguish it from a genuine step failure.
    if (cancelRequested.has(runId)) {
      write(log, `\n[runner] run cancelled — process killed.\n`);
      return "cancelled";
    }
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
 * `log`, and enforce `timeoutMs` by SIGKILL-ing the whole group on expiry. When
 * `env` is given it is layered over the runner's own environment. The spawned child
 * is published as `activeChild` so cancelRun() can kill it mid-flight.
 */
function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  log: WriteStream,
  env?: Record<string, string>,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (err) {
      write(log, `\n[runner] failed to spawn ${command}: ${err instanceof Error ? err.message : String(err)}\n`);
      resolve({ code: 1, timedOut: false });
      return;
    }
    // Publish for cancelRun(); only one process is ever in flight (single job, serial steps).
    activeChild = child;
    const clearActive = () => { if (activeChild === child) activeChild = null; };

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
      clearActive();
      write(log, `\n[runner] process error: ${err.message}\n`);
      resolve({ code: 1, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearActive();
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
