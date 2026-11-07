/**
 * A text diff table with inline review comments: hover a line to reveal a comment
 * button, compose anchored to that line (single comment or start a review), and
 * see resolved-aware threads rendered beneath the line they annotate. Purpose-
 * built for the PR Files view — the shared TextFileDiffViewer stays untouched so
 * commit diffs keep their read-only rendering.
 *
 * GitHub's toolbar options (#252): unified or split, and the unchanged lines
 * between hunks, revealed twenty at a time from the file at the PR's head.
 */
import { Fragment, useState } from "react";
import type { DiffLine, FileDiff } from "../../../types";
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
import { contextLines, hunkGaps, splitRows, type Gap } from "./diffLayout";

type Anchor = { side: "base" | "incoming"; line: number };

/** Lines revealed per click on an expander, as on GitHub. */
const EXPAND_STEP = 20;

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

const tone = (line: DiffLine | null) => ({
  bg: line?.type === "add" ? "bg-fh-success-muted" : line?.type === "remove" ? "bg-fh-danger-muted" : "",
  fg: line?.type === "add" ? "text-fh-success-fg" : line?.type === "remove" ? "text-fh-danger-fg" : "text-fh-fg",
  prefix: line?.type === "add" ? "+" : line?.type === "remove" ? "-" : " ",
});

export function CommentableTextDiff({
  file,
  filePath,
  threads,
  repo,
  review,
  view = "unified",
  loadFile,
}: {
  file: FileDiff;
  filePath: string;
  threads: ReviewThreadData[];
  repo: RepoRef;
  review: ReviewInteraction;
  /** Unified (one column) or split (old | new), from the Files changed toolbar. */
  view?: "unified" | "split";
  /** The file's lines at the head, for revealing unchanged lines; absent: no expanders. */
  loadFile?: () => Promise<string[] | null>;
}) {
  const [composeKey, setComposeKey] = useState<string | null>(null);
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  // How many hidden lines each gap shows, keyed by the hunk it sits above.
  const [revealed, setRevealed] = useState<Record<number, number>>({});

  if (file.binary) {
    return <BelowFileThreads threads={threads} repo={repo} review={review} label="Binary file changed" />;
  }
  if (file.hunks.length === 0) {
    return <BelowFileThreads threads={threads} repo={repo} review={review} label="No textual changes" />;
  }

  function openCompose(anchor: Anchor) {
    setComposeKey(keyOf(anchor));
  }

  function submitCompose(anchor: Anchor, body: string, mode: ComposeMode, suggestion?: string) {
    review.onCreate(filePath, { type: "text", side: anchor.side, line: anchor.line }, body, mode, suggestion);
    setComposeKey(null);
  }

  async function expand(gap: Gap) {
    let lines = fileLines;
    if (!lines) {
      if (!loadFile || loadingFile) return;
      setLoadingFile(true);
      lines = await loadFile().catch(() => null);
      setLoadingFile(false);
      if (!lines) return;
      setFileLines(lines);
    }
    setRevealed((r) => ({ ...r, [gap.before]: Math.min((r[gap.before] ?? 0) + EXPAND_STEP, gap.to - gap.from + 1) }));
  }

  const split = view === "split";
  const cols = split ? 6 : 4;
  // The end-of-file gap needs the file's length, known once it's loaded; until
  // then a single expander stands in for it.
  const gaps = hunkGaps(file.hunks, fileLines?.length ?? Number.MAX_SAFE_INTEGER);

  /** A gap's expander and whatever it has revealed: lines next to the hunk below it, or after the last. */
  function renderGap(gap: Gap | undefined, before: number) {
    if (!gap || !loadFile) return null;
    const total = gap.to === Number.MAX_SAFE_INTEGER ? null : gap.to - gap.from + 1;
    const shown = revealed[before] ?? 0;
    const atEnd = before === file.hunks.length;
    // Above a hunk, reveal the lines nearest it; at the end, the lines after the last hunk.
    const from = atEnd ? gap.from : Math.max(gap.from, gap.to - shown + 1);
    const to = atEnd ? Math.min(gap.to, gap.from + shown - 1) : gap.to;
    const lines = fileLines && shown > 0 ? contextLines(fileLines, from, to, gap.offset) : [];
    const remaining = total === null ? null : total - shown;
    const expander = (remaining === null || remaining > 0) && (
      <tr key={`x${before}`} className="bg-fh-accent-muted/60">
        <td colSpan={cols} className="px-2 py-0.5">
          <button
            type="button"
            onClick={() => void expand(gap)}
            disabled={loadingFile}
            className="inline-flex items-center gap-1.5 text-fh-xs font-sans text-fh-accent-fg hover:underline disabled:opacity-60"
          >
            <span aria-hidden>↕</span>
            {loadingFile ? "Loading…" : remaining === null || remaining > EXPAND_STEP ? `Show ${EXPAND_STEP} more lines` : `Show ${remaining} hidden ${remaining === 1 ? "line" : "lines"}`}
          </button>
        </td>
      </tr>
    );
    const rows = lines.map((line, i) => (split ? renderSplit({ left: line, right: line }, `g${before}-${i}`) : renderUnified(line, `g${before}-${i}`)));
    return atEnd ? <>{rows}{expander}</> : <>{expander}{rows}</>;
  }

  /** The thread and composer row under a line. */
  function renderThreads(key: string, rowThreads: ReviewThreadData[], anchor: Anchor | null, seed: string | null) {
    const isComposing = anchor != null && composeKey === keyOf(anchor);
    if (rowThreads.length === 0 && !isComposing) return null;
    return (
      <tr key={`${key}-t`}>
        <td colSpan={cols} className="p-0 border-b border-fh-border bg-fh-canvas">
          <div className="px-3 py-2 space-y-2 font-sans" style={{ fontSize: 13 }}>
            {rowThreads.map((t) => (
              <ReviewThread
                key={t.root.id}
                thread={t}
                repo={repo}
                currentUser={review.currentUser}
                canResolve={review.canResolve(t.root.author)}
                canApplySuggestion={review.canApplySuggestion}
                busy={review.busy}
                onReply={review.onReply}
                onToggleResolve={review.onToggleResolve}
                onApplySuggestion={review.onApplySuggestion}
                reactionCtx={review.reactionCtx}
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
                // Suggestions replace the anchored line at the PR
                // head, so only incoming-side anchors seed one.
                suggestionSeed={anchor.side === "incoming" ? seed : null}
                onSubmit={(body, mode, suggestion) => submitCompose(anchor, body, mode, suggestion)}
                onCancel={() => setComposeKey(null)}
                ctx={review.reactionCtx}
              />
            )}
          </div>
        </td>
      </tr>
    );
  }

  function commentButton(anchor: Anchor | null) {
    if (!review.canComment || !anchor || composeKey === keyOf(anchor)) return null;
    return (
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
    );
  }

  function renderUnified(line: DiffLine, key: string) {
    const t = tone(line);
    const anchor = anchorForRow(line.oldLineNo, line.newLineNo);
    return (
      <Fragment key={key}>
        <tr className={cx("group", t.bg)}>
          <td className="select-none px-1 py-0 border-r border-fh-border align-middle text-center" style={{ width: 28 }}>
            {commentButton(anchor)}
          </td>
          <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
            {line.oldLineNo ?? ""}
          </td>
          <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
            {line.newLineNo ?? ""}
          </td>
          <td className={cx("pl-2 pr-4 whitespace-pre", t.fg)}>
            <span className="select-none mr-2" style={{ opacity: 0.7 }}>{t.prefix}</span>
            {line.content}
          </td>
        </tr>
        {renderThreads(key, threadsForRow(threads, line.oldLineNo, line.newLineNo), anchor, line.content)}
      </Fragment>
    );
  }

  /** One side-by-side row: the old line on the left, the new one on the right. */
  function renderSplit(row: { left: DiffLine | null; right: DiffLine | null }, key: string) {
    const same = row.left === row.right;
    // Comments on unchanged lines go to the new side, as in the unified view.
    const leftAnchor: Anchor | null = row.left && !same && row.left.oldLineNo != null ? { side: "base", line: row.left.oldLineNo } : null;
    const rightAnchor = row.right ? anchorForRow(null, row.right.newLineNo) : null;
    const rowThreads = threadsForRow(threads, row.left?.oldLineNo ?? null, row.right?.newLineNo ?? null);
    const composingLeft = leftAnchor && composeKey === keyOf(leftAnchor);
    const half = (line: DiffLine | null, anchor: Anchor | null, side: "left" | "right") => {
      const t = tone(line);
      const n = side === "left" ? line?.oldLineNo : line?.newLineNo;
      return (
        <>
          <td className={cx("select-none px-1 py-0 border-r border-fh-border align-middle text-center", t.bg)} style={{ width: 24 }}>
            {line && commentButton(anchor)}
          </td>
          <td className={cx("select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle", t.bg)} style={{ width: 40, minWidth: 40 }}>
            {n ?? ""}
          </td>
          <td className={cx("pl-2 pr-4 whitespace-pre w-1/2", line ? t.bg : "bg-fh-canvas", t.fg, side === "left" && "border-r border-fh-border")}>
            {line && <span className="select-none mr-2" style={{ opacity: 0.7 }}>{t.prefix}</span>}
            {line?.content}
          </td>
        </>
      );
    };
    return (
      <Fragment key={key}>
        <tr className="group">
          {half(row.left, leftAnchor, "left")}
          {half(row.right, rightAnchor, "right")}
        </tr>
        {renderThreads(key, rowThreads, composingLeft ? leftAnchor : rightAnchor ?? leftAnchor, row.right?.content ?? null)}
      </Fragment>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse", split && "table-fixed")} style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        {/* A fixed layout takes its widths from here, not from the first row (an expander spans them all). */}
        {split && (
          <colgroup>
            <col style={{ width: 24 }} />
            <col style={{ width: 48 }} />
            <col />
            <col style={{ width: 24 }} />
            <col style={{ width: 48 }} />
            <col />
          </colgroup>
        )}
        <tbody>
          {file.hunks.map((hunk, hi) => (
            <Fragment key={`h${hi}`}>
              {renderGap(gaps.find((g) => g.before === hi), hi)}
              <tr className="bg-fh-accent-muted">
                <td colSpan={split ? 2 : 3} className="select-none px-1 py-0.5 border-r border-fh-border" />
                <td colSpan={split ? 4 : 1} className="px-3 py-0.5 text-fh-accent-fg">{hunk.header}</td>
              </tr>
              {split
                ? splitRows(hunk.lines).map((row, ri) => renderSplit(row, `${hi}-${ri}`))
                : hunk.lines.map((line, li) => renderUnified(line, `${hi}-${li}`))}
            </Fragment>
          ))}
          {renderGap(gaps.find((g) => g.before === file.hunks.length), file.hunks.length)}
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
