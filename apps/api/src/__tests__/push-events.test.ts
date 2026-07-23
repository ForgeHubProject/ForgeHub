import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../webhook-service.js", () => ({
  emitRepoEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ci/trigger.js", () => ({
  triggerWorkflowsForPush: vi.fn().mockResolvedValue(undefined),
}));

import { emitRepoEvent } from "../webhook-service.js";
import { triggerWorkflowsForPush } from "../ci/trigger.js";
import { emitPushEvents, ZERO_SHA } from "../push-events.js";

/**
 * Unit coverage for the shared push fan-out (wave-B MINOR-1). This is the helper
 * the git-http post-receive path and the server-side merge handlers both use to
 * emit `push` webhooks and enqueue push CI, so a merge commit is indistinguishable
 * from a client push downstream.
 */
describe("emitPushEvents", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits one `push` webhook per changed ref with the git-http payload shape", () => {
    emitPushEvents("repo-1", "owner/widget.git", "user-1", [
      { branch: "main", oldSha: "aaa", newSha: "bbb" },
      { branch: "dev", oldSha: "ccc", newSha: "ddd" },
    ]);

    expect(vi.mocked(emitRepoEvent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(emitRepoEvent)).toHaveBeenCalledWith({
      repoId: "repo-1", event: "push", senderId: "user-1",
      subject: { ref: "refs/heads/main", branch: "main", before: "aaa", after: "bbb" },
    });
    expect(vi.mocked(emitRepoEvent)).toHaveBeenCalledWith({
      repoId: "repo-1", event: "push", senderId: "user-1",
      subject: { ref: "refs/heads/dev", branch: "dev", before: "ccc", after: "ddd" },
    });
  });

  it("enqueues push CI for the changed refs", () => {
    const changed = [{ branch: "main", oldSha: ZERO_SHA, newSha: "bbb" }];
    emitPushEvents("repo-1", "owner/widget.git", "user-1", changed);

    expect(vi.mocked(triggerWorkflowsForPush)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(triggerWorkflowsForPush)).toHaveBeenCalledWith("repo-1", "owner/widget.git", changed);
  });

  it("no-ops the webhook loop for an empty changeset (still calls CI, which self-guards)", () => {
    emitPushEvents("repo-1", "owner/widget.git", "user-1", []);
    expect(vi.mocked(emitRepoEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(triggerWorkflowsForPush)).toHaveBeenCalledWith("repo-1", "owner/widget.git", []);
  });
});
