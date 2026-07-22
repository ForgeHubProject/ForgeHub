/**
 * A text diff table with inline review comments: hover a line to reveal a comment
 * button, compose anchored to that line (single comment or start a review), and
 * see resolved-aware threads rendered beneath the line they annotate. Purpose-
 * built for the PR Files view — the shared TextFileDiffViewer stays untouched so
 * commit diffs keep their read-only rendering.
 */
import { Fragment, useState } from "react";
import type { FileDiff } from "../../../types";
import type { RepoRef } from "../../../lib/autolink";
import { cx } from "../../../ui";
import {
  FileThreadList,
  InlineComposer,
  ReviewThread,
  type ComposeMode,
  type ReviewInteraction,
  type ReviewThreadData,
} from "./reviewShared";

type Anchor = { side: "base" | "incoming"; line: number };

/** Where a new comment on this row anchors: the incoming line if present, else base. */
function anchorForRow(oldNo: number | null, newNo: number | null): Anchor | null {
  if (newNo != null) return { side: "incoming", line: newNo };
  if (oldNo != null) return { side: "base", line: oldNo };
  return null;
}

function keyOf(a: Anchor): string {
  return `${a.side}:${a.line}`;
}

/** Threads whose text position matches one of a row's line anchors. */
function threadsForRow(threads: ReviewThreadData[], oldNo: number | null, newNo: number | null): ReviewThreadData[] {
  return threads.filter((t) => {
    const p = t.root.position;
    if (p.type !== "text") return false;
    if (p.side === "base") return oldNo != null && p.line === oldNo;
    return newNo != null && p.line === newNo;
  });
}

export function CommentableTextDiff({
  file,
  filePath,
  threads,
  repo,
  review,
}: {
  file: FileDiff;
  filePath: string;
  threads: ReviewThreadData[];
  repo: RepoRef;
  review: ReviewInteraction;
}) {
  const [composeKey, setComposeKey] = useState<string | null>(null);

  if (file.binary) {
    return <BelowFileThreads threads={threads} repo={repo} review={review} label="Binary file changed" />;
  }
  if (file.hunks.length === 0) {
    return <BelowFileThreads threads={threads} repo={repo} review={review} label="No textual changes" />;
  }

  function openCompose(anchor: Anchor) {
    setComposeKey(keyOf(anchor));
  }

  function submitCompose(anchor: Anchor, body: string, mode: ComposeMode) {
    review.onCreate(filePath, { type: "text", side: anchor.side, line: anchor.line }, body, mode);
    setComposeKey(null);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <tbody>
          {file.hunks.map((hunk, hi) => (
            <Fragment key={`h${hi}`}>
              <tr className="bg-fh-accent-muted">
                <td className="select-none px-1 py-0.5 border-r border-fh-border" style={{ width: 28 }} />
                <td className="select-none px-2 py-0.5 text-right border-r border-fh-border text-fh-fg-subtle" style={{ width: 40 }} />
                <td className="select-none px-2 py-0.5 text-right border-r border-fh-border text-fh-fg-subtle" style={{ width: 40 }} />
                <td className="px-3 py-0.5 text-fh-accent-fg">{hunk.header}</td>
              </tr>
              {hunk.lines.map((line, li) => {
                const rowBg =
                  line.type === "add" ? "bg-fh-success-muted"
                  : line.type === "remove" ? "bg-fh-danger-muted"
                  : "";
                const rowFg =
                  line.type === "add" ? "text-fh-success-fg"
                  : line.type === "remove" ? "text-fh-danger-fg"
                  : "text-fh-fg";
                const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                const anchor = anchorForRow(line.oldLineNo, line.newLineNo);
                const rowThreads = threadsForRow(threads, line.oldLineNo, line.newLineNo);
                const isComposing = anchor != null && composeKey === keyOf(anchor);

                return (
                  <Fragment key={`${hi}-${li}`}>
                    <tr className={cx("group", rowBg)}>
                      <td className="select-none px-1 py-0 border-r border-fh-border align-middle text-center" style={{ width: 28 }}>
                        {review.canComment && anchor && !isComposing && (
                          <button
                            type="button"
                            aria-label="Add a review comment on this line"
                            title="Add a review comment"
                            onClick={() => openCompose(anchor)}
                            className={cx(
                              "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                              "inline-flex items-center justify-center w-4 h-4 rounded",
                              "bg-fh-accent-emphasis text-fh-on-emphasis leading-none cursor-pointer border-none",
                            )}
                          >
                            <span className="text-[12px] font-bold" style={{ lineHeight: 0 }}>+</span>
                          </button>
                        )}
                      </td>
                      <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
                        {line.oldLineNo ?? ""}
                      </td>
                      <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
                        {line.newLineNo ?? ""}
                      </td>
                      <td className={cx("pl-2 pr-4 whitespace-pre", rowFg)}>
                        <span className="select-none mr-2" style={{ opacity: 0.7 }}>{prefix}</span>
                        {line.content}
                      </td>
                    </tr>

                    {(rowThreads.length > 0 || isComposing) && (
                      <tr>
                        <td colSpan={4} className="p-0 border-b border-fh-border bg-fh-canvas">
                          <div className="px-3 py-2 space-y-2 font-sans" style={{ fontSize: 13 }}>
                            {rowThreads.map((t) => (
                              <ReviewThread
                                key={t.root.id}
                                thread={t}
                                repo={repo}
                                currentUser={review.currentUser}
                                canResolve={review.canResolve(t.root.author)}
                                busy={review.busy}
                                onReply={review.onReply}
                                onToggleResolve={review.onToggleResolve}
                                anchored
                              />
                            ))}
                            {isComposing && anchor && (
                              <InlineComposer
                                currentUser={review.currentUser}
                                hasPendingReview={review.hasPendingReview}
                                busy={review.busy}
                                autoFocus
                                placeholder={`Comment on line ${anchor.line}`}
                                onSubmit={(body, mode) => submitCompose(anchor, body, mode)}
                                onCancel={() => setComposeKey(null)}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fallback frame for binary / no-diff files: still surface any threads on them. */
function BelowFileThreads({
  threads,
  repo,
  review,
  label,
}: {
  threads: ReviewThreadData[];
  repo: RepoRef;
  review: ReviewInteraction;
  label: string;
}) {
  return (
    <div className="px-4 py-3 space-y-2">
      <p className="text-fh-sm text-fh-fg-muted italic">{label}</p>
      <FileThreadList threads={threads} repo={repo} review={review} />
    </div>
  );
}
