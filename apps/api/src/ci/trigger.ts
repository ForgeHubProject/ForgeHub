import { writeFile } from "node:fs/promises";
import { prisma } from "../prisma.js";
import { ciLogPath, ciRunDir, ensureCiDir } from "../git-storage.js";
import { enqueueRun, isCiEnabled } from "./runner.js";
import { pruneCompletedRuns } from "./retention.js";
import {
  branchAllowed,
  defaultWorkflowName,
  listWorkflowFilesAtCommit,
  parseWorkflow,
  type CiEvent,
  type ParsedWorkflow,
} from "./workflows.js";

/**
 * CI trigger layer (issue #86). Turns "a commit was pushed / a PR head moved"
 * into WorkflowRun + CheckRun rows and hands the runnable ones to the in-process
 * queue. Best-effort and fire-and-forget from the caller's perspective — mirrors
 * the webhook side-channel: a CI failure must never fail the push/PR request.
 *
 * When `FORGEHUB_CI` is unset, EVERY entry point is a no-op: no runs are recorded
 * and no workflow files are even parsed (see the runner's security note).
 */

type TriggerParams = {
  repoId: string;
  storageKey: string;
  commitSha: string;
  event: CiEvent;
  ref?: string;
  /** For pull_request events: the PR's TARGET (base) branch, matched by pr filters. */
  baseBranch?: string;
  prId?: string;
};

/** Core: parse the commit's workflows and enqueue runs for those matching `event` (and any branch filter). */
export async function triggerWorkflows(p: TriggerParams): Promise<void> {
  if (!isCiEnabled()) return;

  const files = await listWorkflowFilesAtCommit(p.storageKey, p.commitSha);
  for (const file of files) {
    const parsed = parseWorkflow(file.content, defaultWorkflowName(file.path));
    if (!parsed.ok) {
      // A broken file surfaces as a failed run so the author sees the error;
      // it never crashes the push (the whole call is fire-and-forget anyway).
      await recordParseFailure(p, file.path, parsed.error);
      continue;
    }
    if (!parsed.workflow.events.includes(p.event)) continue;
    // Branch filters (v1): a `push` filter matches the pushed branch; a
    // `pull_request` filter matches the PR's TARGET (base) branch. An unfiltered
    // event triggers on every branch (v0 behavior).
    if (p.event === "push" && !branchAllowed(parsed.workflow.branchFilters.push, p.ref)) continue;
    if (p.event === "pull_request" && !branchAllowed(parsed.workflow.branchFilters.pull_request, p.baseBranch)) continue;
    await createAndEnqueueRun(p, file.path, parsed.workflow);
  }
}

async function createAndEnqueueRun(p: TriggerParams, workflowPath: string, workflow: ParsedWorkflow): Promise<void> {
  const run = await prisma.workflowRun.create({
    data: {
      repoId: p.repoId,
      commitSha: p.commitSha,
      trigger: p.event,
      ref: p.ref ?? null,
      prId: p.prId ?? null,
      workflowName: workflow.name,
      workflowPath,
      status: "queued",
      checkRuns: {
        create: workflow.jobs.map((j) => ({ jobId: j.id, jobName: j.name, status: "queued" })),
      },
    },
  });
  enqueueRun(run.id);
  // Retention (v1): cap a repo's completed-run history on disk + in the DB.
  await pruneCompletedRuns(p.repoId, p.storageKey).catch((err) =>
    console.error("[ci-retention] prune after enqueue failed", err),
  );
}

/**
 * Re-run (v1): create a FRESH queued WorkflowRun that clones a source run's
 * repo/sha/workflow/trigger/ref/pr, linked back via `rerunOfId`, with a fresh
 * queued CheckRun per job (same job ids/names — the sha is identical, so the runner
 * re-reads the very same immutable workflow file). Enqueues it and prunes old runs.
 * Returns the new run id.
 */
export async function createRerun(source: {
  id: string;
  repoId: string;
  storageKey: string;
  commitSha: string;
  trigger: string;
  ref: string | null;
  prId: string | null;
  workflowName: string;
  workflowPath: string;
  checkRuns: Array<{ jobId: string; jobName: string }>;
}): Promise<string> {
  const run = await prisma.workflowRun.create({
    data: {
      repoId: source.repoId,
      commitSha: source.commitSha,
      trigger: source.trigger,
      ref: source.ref,
      prId: source.prId,
      workflowName: source.workflowName,
      workflowPath: source.workflowPath,
      status: "queued",
      rerunOfId: source.id,
      checkRuns: {
        create: source.checkRuns.map((c) => ({ jobId: c.jobId, jobName: c.jobName, status: "queued" })),
      },
    },
  });
  enqueueRun(run.id);
  await pruneCompletedRuns(source.repoId, source.storageKey).catch((err) =>
    console.error("[ci-retention] prune after rerun failed", err),
  );
  return run.id;
}

async function recordParseFailure(p: TriggerParams, workflowPath: string, error: string): Promise<void> {
  const now = new Date();
  const run = await prisma.workflowRun.create({
    data: {
      repoId: p.repoId,
      commitSha: p.commitSha,
      trigger: p.event,
      ref: p.ref ?? null,
      prId: p.prId ?? null,
      workflowName: defaultWorkflowName(workflowPath),
      workflowPath,
      status: "completed",
      conclusion: "failure",
      startedAt: now,
      completedAt: now,
      checkRuns: {
        create: [
          { jobId: "workflow", jobName: "workflow", status: "completed", conclusion: "failure", startedAt: now, completedAt: now },
        ],
      },
    },
    include: { checkRuns: true },
  });

  const check = run.checkRuns[0];
  const logPath = ciLogPath(p.storageKey, run.id, check.jobId);
  await ensureCiDir(ciRunDir(p.storageKey, run.id));
  await writeFile(logPath, `Workflow ${workflowPath} could not be parsed:\n\n${error}\n`, "utf8");
  await prisma.checkRun.update({ where: { id: check.id }, data: { logPath } });
}

// ─── Hook-point wrappers ───────────────────────────────────────────────────────

type ChangedRef = { branch: string; oldSha: string; newSha: string };

/** Post-receive: enqueue `push`-event runs for each changed branch tip. */
export async function triggerWorkflowsForPush(
  repoId: string,
  storageKey: string,
  changed: ChangedRef[],
): Promise<void> {
  if (!isCiEnabled() || changed.length === 0) return;
  for (const c of changed) {
    await triggerWorkflows({ repoId, storageKey, commitSha: c.newSha, event: "push", ref: c.branch });
  }
}

/**
 * Post-receive: for every OPEN PR whose head branch just moved, enqueue a
 * `pull_request`-event run at the new head — this is where a PR "learns" of new
 * head commits (same set the `head_pushed` timeline event is emitted from).
 */
export async function triggerWorkflowsForPrSync(
  repoId: string,
  storageKey: string,
  changed: ChangedRef[],
): Promise<void> {
  if (!isCiEnabled() || changed.length === 0) return;
  const byBranch = new Map(changed.map((c) => [c.branch, c]));
  const prs = await prisma.pullRequest.findMany({
    where: { repoId, state: "OPEN", fromBranch: { in: [...byBranch.keys()] } },
    select: { id: true, fromBranch: true, toBranch: true },
  });
  for (const pr of prs) {
    const c = byBranch.get(pr.fromBranch);
    if (!c) continue;
    await triggerWorkflows({
      repoId, storageKey, commitSha: c.newSha, event: "pull_request",
      ref: pr.fromBranch, baseBranch: pr.toBranch, prId: pr.id,
    });
  }
}

/** PR open: enqueue a `pull_request`-event run at the PR head. */
export async function triggerWorkflowsForPrOpen(
  repoId: string,
  storageKey: string,
  prId: string,
  fromBranch: string,
  headSha: string,
  baseBranch?: string,
): Promise<void> {
  if (!isCiEnabled()) return;
  await triggerWorkflows({
    repoId, storageKey, commitSha: headSha, event: "pull_request",
    ref: fromBranch, baseBranch, prId,
  });
}
