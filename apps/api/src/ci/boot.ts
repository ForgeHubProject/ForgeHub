import { rm } from "node:fs/promises";
import { prisma } from "../prisma.js";
import { ciWorkRoot, legacyCiWorkRoot } from "../git-storage.js";

/**
 * CI startup recovery (issue #86, Tier 0).
 *
 * The runner's queue and its notion of "which run is executing" live entirely in
 * this process's heap. A restart — a deploy, an OOM kill, a crash — therefore
 * destroys both, and leaves two kinds of debris behind that nothing ever cleaned
 * up. Both are repaired here, at boot, before the queue can start moving again.
 *
 * Deliberately NOT gated on `FORGEHUB_CI`: the debris is from a period when CI
 * *was* enabled, and an operator who has just turned the feature off is exactly
 * the operator who most wants the leftovers gone.
 */

/**
 * (1) Delete every job workspace.
 *
 * Retention (`retention.ts`) prunes by *run count* and only ever touches COMPLETED
 * runs' log directories — it never looks at `<ci-root>/.work/`. So a restart in the
 * middle of a job left that job's workspace, a full `--no-hardlinks` clone of the
 * repo, on disk forever: nothing deletes it, and nothing even knows it is there.
 * Enough interrupted jobs and the volume fills.
 *
 * The whole directory can go unconditionally because a workspace only ever exists
 * while its job is executing, and at boot no job is executing: the queue is empty
 * by construction. Best-effort — a disk error here must never stop the API booting.
 */
export async function sweepCiWorkspaces(): Promise<void> {
  // Both roots: the one in use, and — when FORGEHUB_CI_ROOT has moved the CI tree —
  // the default one it moved away from. Relocating the root is exactly the upgrade
  // that would otherwise strand every workspace an interrupted job left behind,
  // making the leak this function exists to fix permanent for existing installs.
  const roots = [ciWorkRoot(), legacyCiWorkRoot()].filter((r): r is string => r !== null);
  for (const workRoot of roots) {
    try {
      await rm(workRoot, { recursive: true, force: true });
    } catch (err) {
      console.error(`[ci-boot] failed to sweep CI workspaces at ${workRoot}`, err);
    }
  }
}

/**
 * (2) Fail every run that the restart orphaned.
 *
 * A run left `queued` or `running` when the process died is never resumed — the
 * queue was in memory — and no timeout finalizes it either. It stays non-completed
 * forever, and that is not merely untidy:
 *
 *   `summary.ts` counts any non-completed CheckRun as PENDING, and
 *   `branch-protection.ts` refuses to merge while anything is pending.
 *
 * So a single restart at the wrong moment makes every PR at that commit
 * PERMANENTLY UNMERGEABLE, with no UI affordance other than a human hunting down
 * the run and cancelling it by hand. Marking the wreckage `failure` at boot turns
 * a permanent wedge into an ordinary red check that "re-run" clears.
 *
 * `failure` rather than `cancelled` is the honest label: nobody asked for this to
 * stop, and it must not read as green to branch protection either way.
 *
 * Note this does NOT kill the orphaned detached children themselves — they were
 * spawned with `detached: true` into their own process groups and outlived their
 * parent, so their pids are gone with the heap that held them. In a container they
 * die with the container; on a bare host they may still be running. Reaping those
 * properly needs the runner extracted into a process whose lifetime we control
 * (the next stage of #86), and is out of scope here.
 *
 * Returns the number of runs finalized.
 */
export async function failOrphanedRuns(): Promise<number> {
  const orphaned = await prisma.workflowRun.findMany({
    where: { status: { not: "completed" } },
    select: { id: true },
  });
  if (orphaned.length === 0) return 0;

  const ids = orphaned.map((r) => r.id);
  const completedAt = new Date();

  // Jobs first, then the runs: if this is interrupted halfway, a run that still
  // reads non-completed will be picked up again by the next boot, whereas a
  // completed run with pending jobs would keep the PR wedged.
  await prisma.checkRun.updateMany({
    where: { workflowRunId: { in: ids }, status: { not: "completed" } },
    data: { status: "completed", conclusion: "failure", completedAt },
  });
  await prisma.workflowRun.updateMany({
    where: { id: { in: ids }, status: { not: "completed" } },
    data: { status: "completed", conclusion: "failure", completedAt },
  });

  console.log(`[ci-boot] failed ${ids.length} run(s) orphaned by a restart`);
  return ids.length;
}

/** Both recovery steps, in order. Best-effort: never blocks or fails a boot. */
export async function ciStartupRecovery(): Promise<void> {
  await sweepCiWorkspaces().catch((err) => console.error("[ci-boot] workspace sweep failed", err));
  await failOrphanedRuns().catch((err) => console.error("[ci-boot] orphan reaping failed", err));
}
