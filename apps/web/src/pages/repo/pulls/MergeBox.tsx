import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, closePull, mergePull, resolveMergePr, revertPull } from "../../../api";
import type { PullRequest } from "../../../types";
import { Button, ConfirmDialog, DropdownMenu, Icons, RelativeTime, cx } from "../../../ui";
import { AlertIcon, BranchChip, CheckCircleIcon, GitMergeIcon, PRStateIcon } from "./prShared";
import {
  MERGE_METHOD_OPTIONS,
  mergeMethodOption,
  readMergeMethod,
  writeMergeMethod,
  isConflictError,
  type MergeMethod,
} from "./mergeMethods";

/** Back-arrow glyph for the revert action (token-tinted, currentColor). */
function RevertIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M1.22 6.28a.75.75 0 0 0 1.06 0L4 4.56v4.69A3.75 3.75 0 0 0 7.75 13h4.5a.75.75 0 0 0 0-1.5h-4.5A2.25 2.25 0 0 1 5.5 9.25V4.56l1.72 1.72a.75.75 0 1 0 1.06-1.06L5.53 2.22a.75.75 0 0 0-1.06 0L1.22 5.22a.75.75 0 0 0 0 1.06Z" />
    </svg>
  );
}

const readableMethod: Record<MergeMethod, string> = {
  merge: "merged",
  squash: "squashed and merged",
  rebase: "rebased and merged",
};

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The merge box. For a clean PR it offers a GitHub-style split-button to merge
 * via one of three methods (merge / squash / rebase — the last choice is
 * remembered per repo); when the branch has conflicts it surfaces ForgeHub's
 * merge-conflict resolution flow (the /merge-resolve API) inline. A merged PR
 * gains a Revert action that opens a reverting PR. The conflict-resolution
 * wiring (resolveMergePr) is unchanged — only merge/revert chrome is added.
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
  const navigate = useNavigate();
  const [merging, setMerging] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resolving, setResolving] = useState<null | "ours" | "theirs">(null);
  const [reverting, setReverting] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod>(() => readMergeMethod(handle, repoName, browserStorage()));

  const busy = merging || closing || resolving !== null;
  const hasConflict = pr.mergeable === false;

  function selectMethod(next: MergeMethod) {
    setMethod(next);
    writeMergeMethod(handle, repoName, next, browserStorage());
  }

  async function doMerge(useMethod: MergeMethod) {
    setMerging(true);
    setError(null);
    try {
      await mergePull(token, handle, repoName, pr.number, useMethod);
      onUpdate({ ...pr, state: "merged", mergeMethod: useMethod, mergedAt: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Merge failed";
      setError(msg);
      if (isConflictError(msg)) onUpdate({ ...pr, mergeable: false });
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

  async function doRevert() {
    setReverting(true);
    setError(null);
    try {
      const revertPr = await revertPull(token, handle, repoName, pr.number);
      setConfirmRevert(false);
      navigate(`/${handle}/${repoName}/pulls/${revertPr.number}`);
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 409
          ? err.message
          : err instanceof Error
            ? err.message
            : "Revert failed";
      setError(msg);
      setConfirmRevert(false);
    } finally {
      setReverting(false);
    }
  }

  // ── Terminal states ────────────────────────────────────────────────────────
  if (pr.state === "merged") {
    return (
      <div className="rounded-md border border-fh-purple-muted bg-fh-purple-muted/40 overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <PRStateIcon state="merged" />
          <p className="text-fh-base font-semibold text-fh-purple-fg">
            Pull request {pr.mergeMethod ? readableMethod[pr.mergeMethod] : "merged"}
            {pr.mergedAt ? " " : ""}
            {pr.mergedAt && <RelativeTime className="font-normal text-fh-fg-muted" date={pr.mergedAt} />}
          </p>
          <Button
            variant="default"
            size="sm"
            className="ml-auto"
            leadingIcon={<RevertIcon size={14} />}
            loading={reverting}
            onClick={() => setConfirmRevert(true)}
          >
            Revert
          </Button>
        </div>
        {error && (
          <div className="px-4 pb-3">
            <p className="text-fh-sm text-fh-danger-fg flex items-start gap-1.5">
              <AlertIcon size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          </div>
        )}
        <ConfirmDialog
          open={confirmRevert}
          title="Revert this pull request?"
          message={
            <>
              This opens a new pull request that reverts the changes merged by{" "}
              <span className="font-semibold">{pr.title}</span> (#{pr.number}).
            </>
          }
          warning="If the revert conflicts with the base branch, it can't be applied automatically yet."
          confirmLabel="Revert pull request"
          tone="primary"
          loading={reverting}
          onConfirm={doRevert}
          onCancel={() => setConfirmRevert(false)}
        />
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

  const activeOption = mergeMethodOption(method);

  // ── Open PR ────────────────────────────────────────────────────────────────
  // No overflow-hidden here: the merge-method dropdown is absolutely positioned
  // and must be free to extend past the box's bottom edge.
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface">
      {/* Status header */}
      <div
        className={cx(
          "flex items-start gap-2.5 px-4 py-3 border-b border-fh-border rounded-t-md",
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
            <span>
              {error}
              {isConflictError(error) && " Resolve the conflict below, then merge."}
            </span>
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
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    Keep <BranchChip name={pr.fromBranch} className="max-w-[130px]" />
                  </span>
                </Button>
                <Button
                  variant="default"
                  block
                  loading={resolving === "ours"}
                  disabled={busy}
                  onClick={() => doResolve("ours")}
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    Keep <BranchChip name={pr.toBranch} className="max-w-[130px]" />
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
            {/* GitHub-style split button: primary action + method picker. */}
            <div className="inline-flex">
              <Button
                variant="primary"
                leadingIcon={<GitMergeIcon size={15} />}
                loading={merging}
                disabled={busy}
                className="rounded-r-none"
                onClick={() => doMerge(method)}
              >
                {activeOption.buttonLabel}
              </Button>
              <DropdownMenu
                align="start"
                width={340}
                trigger={
                  <Button
                    variant="primary"
                    disabled={busy}
                    aria-label="Choose a merge method"
                    className="rounded-l-none border-l border-fh-on-emphasis/25 px-2"
                  >
                    <Icons.ChevronDownIcon size={14} />
                  </Button>
                }
              >
                {MERGE_METHOD_OPTIONS.map((o) => (
                  <button
                    key={o.method}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => selectMethod(o.method)}
                    className={cx(
                      "w-full flex items-start gap-2 px-3 py-2 text-left bg-transparent border-none cursor-pointer",
                      "outline-none hover:bg-fh-accent-muted focus:bg-fh-accent-muted",
                    )}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0 text-fh-accent-fg">
                      {o.method === method ? <Icons.CheckIcon size={14} /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-fh-sm font-semibold text-fh-fg">{o.menuLabel}</span>
                      <span className="block text-fh-xs text-fh-fg-muted">{o.description}</span>
                    </span>
                  </button>
                ))}
              </DropdownMenu>
            </div>
            <Button variant="danger" size="sm" className="ml-auto" loading={closing} disabled={busy} onClick={doClose}>
              Close pull request
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
