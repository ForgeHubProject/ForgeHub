import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { ingestCommitRange } from "./ingest.js";
import { emitHeadPushedForPush } from "./timeline-service.js";
import { triggerWorkflowsForPrSync } from "./ci/trigger.js";
import { emitPushEvents } from "./push-events.js";
import { installPreReceiveHook } from "./git-hooks.js";
import { syncProtectionConfig } from "./branch-protection.js";
import { syncProtectedTagsConfig } from "./protected-tags.js";

const execFile = promisify(execFileCb);

/**
 * The receive-pack side effects shared by the two write transports (issue #116):
 * smart-HTTP (`routes/git-http.ts`) and SSH (`ssh/server.ts`). Both must behave
 * identically downstream — same branch-protection enforcement before the pack, and
 * the same fire-and-forget ingestion + webhook/CI fan-out after — so a push looks
 * the same to ingestion, webhooks, and CI regardless of transport. Extracted here
 * (rather than duplicated) so there is a single definition of "what a push does".
 */

/** Minimal repo shape the post-receive effects need. */
export type PushRepo = { id: string; storageKey: string };

/** Snapshot every local branch tip (`branch -> sha`); empty for a fresh repo. */
export async function snapshotHeadShas(repoPath: string): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  try {
    const { stdout } = await execFile(
      "git",
      ["for-each-ref", "refs/heads/", "--format=%(refname:short)|%(objectname)"],
      { cwd: repoPath },
    );
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const sep = line.indexOf("|");
      shas.set(line.slice(0, sep), line.slice(sep + 1));
    }
  } catch {
    /* empty repo — first push */
  }
  return shas;
}

/**
 * Ensure the branch-protection pre-receive hook is installed and its rules file
 * reflects current DB policy, BEFORE the pack is accepted. Backfills repos that
 * predate the feature. Best-effort (a failure is logged, not fatal) — matching the
 * existing git-http behavior.
 */
export async function preparePushProtection(
  app: FastifyInstance,
  repoId: string,
  storageKey: string,
  repoPath: string,
): Promise<void> {
  await installPreReceiveHook(repoPath).catch((err) => app.log.error({ err }, "installPreReceiveHook (push)"));
  await syncProtectionConfig(repoId, storageKey).catch((err) => app.log.error({ err }, "syncProtectionConfig (push)"));
  await syncProtectedTagsConfig(repoId, storageKey).catch((err) => app.log.error({ err }, "syncProtectedTagsConfig (push)"));
}

/**
 * After a receive-pack completes, diff branch tips against `shasBefore` and, for
 * every branch whose SHA changed or is new, fire (best-effort, non-blocking):
 * artifact ingestion, `head_pushed` PR events, outbound `push` webhooks + push CI,
 * and `pull_request` CI re-runs for open PRs whose head moved. Identical to the
 * git-http post-receive block so both transports are indistinguishable downstream.
 */
export async function runPostReceiveEffects(
  app: FastifyInstance,
  repo: PushRepo,
  actorId: string,
  repoPath: string,
  shasBefore: Map<string, string>,
): Promise<void> {
  try {
    const { stdout } = await execFile(
      "git",
      ["for-each-ref", "refs/heads/", "--format=%(refname:short)|%(objectname)"],
      { cwd: repoPath },
    );
    const repoId = repo.id;
    const changed: Array<{ branch: string; oldSha: string; newSha: string }> = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const sep = line.indexOf("|");
      const branchName = line.slice(0, sep);
      const newSha = line.slice(sep + 1);
      const oldSha = shasBefore.get(branchName) ?? "0".repeat(40);
      if (newSha !== oldSha) {
        changed.push({ branch: branchName, oldSha, newSha });
        ingestCommitRange(repoId, repoPath, oldSha, newSha).catch((err: unknown) =>
          app.log.error({ err }, `post-push ingestion failed for ${branchName}`),
        );
      }
    }
    emitHeadPushedForPush(repoId, actorId, changed).catch((err: unknown) =>
      app.log.error({ err }, "post-push head_pushed events failed"),
    );
    if (repo.storageKey) {
      const storageKey = repo.storageKey;
      emitPushEvents(repoId, storageKey, actorId, changed);
      void triggerWorkflowsForPrSync(repoId, storageKey, changed).catch((err: unknown) =>
        app.log.error({ err }, "post-push CI (pull_request) failed"),
      );
    }
  } catch {
    /* nothing to ingest */
  }
}
