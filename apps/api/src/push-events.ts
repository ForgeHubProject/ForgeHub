import { emitRepoEvent } from "./webhook-service.js";
import { triggerWorkflowsForPush } from "./ci/trigger.js";

/** A branch tip that moved during a push: old → new sha (oldSha is 40 zeros for a new branch). */
export type ChangedRef = { branch: string; oldSha: string; newSha: string };

/** The all-zero SHA git uses for the "before" side of a branch creation. */
export const ZERO_SHA = "0".repeat(40);

/**
 * Fan-out for a branch-tip move: emit one outbound `push` webhook per changed
 * ref (issue #87) and enqueue Actions-style `push` CI runs (issue #86).
 *
 * Shared by two call sites:
 *  - the git-http post-receive path (a normal client push), and
 *  - the server-side merge handlers, which push direct-to-bare with
 *    `FORGEHUB_INTERNAL_PUSH=1` and therefore bypass post-receive entirely.
 *
 * Both effects are fire-and-forget and best-effort — mirroring the webhook /
 * CI side-channels, a delivery or CI failure must never fail the caller's
 * request. The payload shape matches what the post-receive path already sends so
 * that downstream consumers cannot tell a server-side merge from a client push.
 */
export function emitPushEvents(
  repoId: string,
  storageKey: string,
  senderId: string,
  changed: ChangedRef[],
): void {
  for (const c of changed) {
    void emitRepoEvent({
      repoId,
      event: "push",
      senderId,
      subject: { ref: `refs/heads/${c.branch}`, branch: c.branch, before: c.oldSha, after: c.newSha },
    });
  }
  // No-op unless FORGEHUB_CI=1 (the trigger layer guards on that internally).
  void triggerWorkflowsForPush(repoId, storageKey, changed).catch(() => {});
}
