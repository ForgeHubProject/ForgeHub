import { useState } from "react";
import { closePull, mergePull, resolveMergePr } from "../../../api";
import type { PullRequest } from "../../../types";
import { Button, RelativeTime, cx } from "../../../ui";
import { AlertIcon, BranchChip, CheckCircleIcon, GitMergeIcon, PRStateIcon } from "./prShared";

/**
 * The merge box. For a clean PR it offers the merge/close actions; when the
 * branch has conflicts it surfaces ForgeHub's merge-conflict resolution flow
 * (the /merge-resolve API) inline — pick a side and resolve. The wiring
 * (mergePull / resolveMergePr / closePull) is unchanged; only the chrome is
 * restyled to tokens.
 */
export function MergeBox({
  token,
  handle,
  repoName,
  pr,
  onUpdate,
}: {
  token: string;
  handle: string;
  repoName: string;
  pr: PullRequest;
  onUpdate: (next: PullRequest) => void;
}) {
  const [merging, setMerging] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resolving, setResolving] = useState<null | "ours" | "theirs">(null);
  const [error, setError] = useState<string | null>(null);

  const busy = merging || closing || resolving !== null;
  const hasConflict = pr.mergeable === false;

  async function doMerge() {
    setMerging(true);
    setError(null);
    try {
      await mergePull(token, handle, repoName, pr.number);
      onUpdate({ ...pr, state: "merged", mergedAt: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Merge failed";
      setError(msg);
      if (/conflict|cannot auto-merge/i.test(msg)) onUpdate({ ...pr, mergeable: false });
    } finally {
      setMerging(false);
    }
  }

  async function doResolve(strategy: "ours" | "theirs") {
    setResolving(strategy);
    setError(null);
    try {
      await resolveMergePr(token, handle, repoName, pr.number, { strategy });
      onUpdate({ ...pr, state: "merged", mergedAt: new Date().toISOString() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed");
    } finally {
      setResolving(null);
    }
  }

  async function doClose() {
    setClosing(true);
    setError(null);
    try {
      await closePull(token, handle, repoName, pr.number);
      onUpdate({ ...pr, state: "closed" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close pull request");
    } finally {
      setClosing(false);
    }
  }

  // ── Terminal states ────────────────────────────────────────────────────────
  if (pr.state === "merged") {
    return (
      <div className="rounded-md border border-fh-purple-muted bg-fh-purple-muted/40 px-4 py-3 flex items-center gap-2.5">
        <PRStateIcon state="merged" />
        <p className="text-fh-base font-semibold text-fh-purple-fg">
          Pull request merged{pr.mergedAt ? " " : ""}
          {pr.mergedAt && <RelativeTime className="font-normal text-fh-fg-muted" date={pr.mergedAt} />}
        </p>
      </div>
    );
  }

  if (pr.state === "closed") {
    return (
      <div className="rounded-md border border-fh-danger-muted bg-fh-danger-muted/40 px-4 py-3 flex items-center gap-2.5">
        <PRStateIcon state="closed" />
        <p className="text-fh-base font-semibold text-fh-danger-fg">Pull request closed</p>
      </div>
    );
  }

  // ── Open PR ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      {/* Status header */}
      <div
        className={cx(
          "flex items-start gap-2.5 px-4 py-3 border-b border-fh-border",
          hasConflict ? "bg-fh-danger-muted/40" : "bg-fh-success-muted/40",
        )}
      >
        {hasConflict ? (
          <AlertIcon size={16} className="mt-0.5 shrink-0 text-fh-danger-fg" />
        ) : (
          <CheckCircleIcon size={16} className="mt-0.5 shrink-0 text-fh-success-fg" />
        )}
        <div className="min-w-0">
          <p className={cx("text-fh-base font-semibold", hasConflict ? "text-fh-danger-fg" : "text-fh-success-fg")}>
            {hasConflict ? "This branch has conflicts that must be resolved" : "This branch has no conflicts with the base branch"}
          </p>
          <p className="mt-0.5 text-fh-sm text-fh-fg-muted">
            {hasConflict ? (
              <>Resolving picks one side of the conflicting changes, then merges.</>
            ) : (
              <>Merging is available.</>
            )}
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        {error && (
          <p className="mb-3 text-fh-sm text-fh-danger-fg flex items-start gap-1.5">
            <AlertIcon size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {hasConflict ? (
          <div className="space-y-3">
            <div className="rounded-md border border-fh-border bg-fh-canvas p-3">
              <p className="text-fh-sm font-semibold text-fh-fg mb-2">Resolve conflicts by choosing a side</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  variant="default"
                  block
                  loading={resolving === "theirs"}
                  disabled={busy}
                  onClick={() => doResolve("theirs")}
                  className="justify-start"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    Keep <BranchChip name={pr.fromBranch} className="max-w-[120px]" />
                  </span>
                </Button>
                <Button
                  variant="default"
                  block
                  loading={resolving === "ours"}
                  disabled={busy}
                  onClick={() => doResolve("ours")}
                  className="justify-start"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    Keep <BranchChip name={pr.toBranch} className="max-w-[120px]" />
                  </span>
                </Button>
              </div>
              <p className="mt-2 text-fh-xs text-fh-fg-subtle">
                Keeping <span className="font-mono">{pr.fromBranch}</span> takes the incoming changes; keeping{" "}
                <span className="font-mono">{pr.toBranch}</span> keeps the base branch as-is.
              </p>
            </div>
            <div className="flex items-center">
              <Button variant="danger" size="sm" className="ml-auto" loading={closing} disabled={busy} onClick={doClose}>
                Close pull request
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              leadingIcon={<GitMergeIcon size={15} />}
              loading={merging}
              disabled={busy}
              onClick={doMerge}
            >
              Merge pull request
            </Button>
            <Button variant="danger" size="sm" className="ml-auto" loading={closing} disabled={busy} onClick={doClose}>
              Close pull request
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
