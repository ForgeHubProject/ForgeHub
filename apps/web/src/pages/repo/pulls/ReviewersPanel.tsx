import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listRepoMembers, removeRequestedReviewers, requestReviewers, type RepoMember } from "../../../api";
import type { PullRequest } from "../../../types";
import { Avatar, DropdownItem, DropdownMenu, Icons, Tooltip } from "../../../ui";
import { ReviewVerdictIcon } from "./reviewShared";
import { buildReviewerRows, requestableMembers } from "./reviewersModel";

/**
 * The Reviewers sidebar block (issue #82): who reviewed (verdict icons, from the
 * review summary of issue #81) merged with who was asked to (request state), plus
 * the request / re-request / withdraw affordances for the author and repo owner.
 * Mutations return the fresh requestedReviewers list, which the parent folds back
 * into its PR state via `onRequestsChange` — no full PR refetch needed.
 */
export function ReviewersPanel({
  token,
  handle,
  repoName,
  pr,
  currentUser,
  canManage,
  onRequestsChange,
}: {
  token: string;
  handle: string;
  repoName: string;
  pr: PullRequest;
  currentUser: string;
  canManage: boolean;
  onRequestsChange: (requested: NonNullable<PullRequest["requestedReviewers"]>) => void;
}) {
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requested = pr.requestedReviewers ?? [];
  const rows = buildReviewerRows(pr.reviewSummary, requested);
  const showPicker = canManage && pr.state === "open";

  // Member list feeds the request picker only — skip the fetch when it's hidden.
  useEffect(() => {
    if (!showPicker) return;
    listRepoMembers(token, handle, repoName)
      .then((d) => setMembers(d.members))
      .catch(() => setMembers([]));
  }, [showPicker, token, handle, repoName]);

  const candidates = requestableMembers(members, { author: pr.author, currentUser, requested });

  async function mutate(action: () => Promise<{ requestedReviewers: NonNullable<PullRequest["requestedReviewers"]> }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      onRequestsChange(res.requestedReviewers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update reviewers");
    } finally {
      setBusy(false);
    }
  }

  const request = (reviewer: string) => mutate(() => requestReviewers(token, handle, repoName, pr.number, [reviewer]));
  const withdraw = (reviewer: string) => mutate(() => removeRequestedReviewers(token, handle, repoName, pr.number, [reviewer]));

  return (
    <div className="border-b border-fh-border pb-3 mb-3">
      <div className="flex items-center mb-1.5">
        <p className="font-semibold text-fh-fg">Reviewers</p>
        {showPicker && (
          <DropdownMenu
            align="end"
            width={220}
            trigger={
              <button
                type="button"
                aria-label="Request a review"
                disabled={busy}
                className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded text-fh-fg-muted hover:text-fh-accent-fg hover:bg-fh-surface-muted transition-colors border-none bg-transparent cursor-pointer"
              >
                <GearIcon size={14} />
              </button>
            }
          >
            {candidates.length === 0 ? (
              <p className="px-3 py-2 text-fh-xs text-fh-fg-subtle">No one available to request.</p>
            ) : (
              candidates.map((m) => (
                <DropdownItem key={m.handle} onSelect={() => void request(m.handle)}>
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <Avatar name={m.handle} size={18} />
                    <span className="truncate">{m.handle}</span>
                  </span>
                </DropdownItem>
              ))
            )}
          </DropdownMenu>
        )}
      </div>

      {rows.length > 0 ? (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.handle} className="flex items-center gap-1.5">
              <Avatar name={row.handle} size={18} />
              <Link to={`/${row.handle}`} className="text-fh-sm text-fh-fg hover:text-fh-accent-fg truncate no-underline">
                {row.handle}
              </Link>
              {/* Provenance for an automatic request (issue #89). */}
              {row.request?.viaCodeowners && (
                <Tooltip label="Requested automatically by a CODEOWNERS rule">
                  <span className="text-fh-xs text-fh-fg-subtle font-mono shrink-0">CODEOWNERS</span>
                </Tooltip>
              )}
              <span className="ml-auto inline-flex items-center gap-1">
                {/* Re-request: puts a reviewer who already responded back in the queue. */}
                {showPicker && row.request?.state === "reviewed" && (
                  <Tooltip label="Re-request review">
                    <button
                      type="button"
                      aria-label={`Re-request review from ${row.handle}`}
                      disabled={busy}
                      onClick={() => void request(row.handle)}
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-fh-fg-subtle hover:text-fh-accent-fg hover:bg-fh-surface-muted transition-colors border-none bg-transparent cursor-pointer"
                    >
                      <Icons.SyncIcon size={12} />
                    </button>
                  </Tooltip>
                )}
                {/* Withdraw a still-pending request. */}
                {showPicker && row.request?.state === "requested" && (
                  <Tooltip label="Remove request">
                    <button
                      type="button"
                      aria-label={`Remove review request for ${row.handle}`}
                      disabled={busy}
                      onClick={() => void withdraw(row.handle)}
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-fh-fg-subtle hover:text-fh-danger-fg hover:bg-fh-surface-muted transition-colors border-none bg-transparent cursor-pointer"
                    >
                      <Icons.XIcon size={12} />
                    </button>
                  </Tooltip>
                )}
                {row.review?.stale && <span className="text-fh-xs text-fh-fg-subtle">stale</span>}
                {row.request?.state === "requested" ? (
                  <Tooltip label="Awaiting review">
                    <span aria-label="Awaiting review" className="w-2 h-2 rounded-full bg-fh-warning-fg" />
                  </Tooltip>
                ) : row.review ? (
                  <ReviewVerdictIcon state={row.review.state} size={14} className={row.review.stale ? "opacity-40" : undefined} />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-fh-xs text-fh-fg-subtle">No reviews yet.</p>
      )}
      {error && <p className="mt-1.5 text-fh-xs text-fh-danger-fg">{error}</p>}
    </div>
  );
}

/** Gear glyph for the request-a-review picker trigger (currentColor). */
function GearIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z" />
    </svg>
  );
}
