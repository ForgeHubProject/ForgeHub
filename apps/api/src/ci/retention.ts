import { rm } from "node:fs/promises";
import { prisma } from "../prisma.js";
import { ciRunDir } from "../git-storage.js";

/**
 * Run retention (issue #86, CI v1). A busy repo would otherwise accumulate an
 * unbounded pile of WorkflowRun/CheckRun rows and per-run log directories on disk.
 * After a new run is enqueued we prune a repo's OLDEST COMPLETED runs beyond a cap
 * (env `FORGEHUB_CI_RETENTION`, default 200), deleting both the DB rows (CheckRuns
 * cascade off the WorkflowRun FK) and the log files under `<root>-ci/…`.
 *
 * Only COMPLETED runs count toward the cap and are ever deleted — a queued or
 * running run is never pruned, so an in-flight run cannot be swept out from under
 * the runner. Best-effort: a disk error on one run never blocks the others, and a
 * failure here must never fail the push/PR that triggered the new run.
 */

const DEFAULT_RETENTION = 200;

/** Resolve the retention cap from the environment, clamped to a sane floor. */
export function retentionCap(): number {
  const raw = Number(process.env["FORGEHUB_CI_RETENTION"]);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETENTION;
  return Math.floor(raw);
}

/**
 * Prune a repo's completed runs beyond the retention cap. Returns the number of
 * runs pruned (0 when under the cap). Deletes log directories then DB rows.
 */
export async function pruneCompletedRuns(repoId: string, storageKey: string): Promise<number> {
  const cap = retentionCap();

  // The newest `cap` completed runs are kept; everything older is pruned.
  const stale = await prisma.workflowRun.findMany({
    where: { repoId, status: "completed" },
    orderBy: { createdAt: "desc" },
    skip: cap,
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);

  // Remove each run's on-disk log directory (best-effort, per run).
  for (const id of ids) {
    await rm(ciRunDir(storageKey, id), { recursive: true, force: true }).catch(() => {});
  }

  // Delete the run rows; CheckRun rows cascade off the WorkflowRun FK.
  await prisma.workflowRun.deleteMany({ where: { id: { in: ids } } });

  console.log(`[ci-retention] pruned ${ids.length} completed run(s) for repo ${repoId} (cap ${cap})`);
  return ids.length;
}
