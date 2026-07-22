import { useState } from "react";
import { Link } from "react-router-dom";
import { getPRFileDiff } from "../../../api";
import type { FileDiff, PRFileEntry } from "../../../types";
import type { RepoRef } from "../../../lib/autolink";
import { resolveFileDiffViewer, extensionForFilename } from "../../../views/fileDiffViewerRegistry";
import { useSemanticExtensions } from "../../../lib/fhrFormats";
import { Badge, Skeleton, cx } from "../../../ui";
import { ChevronRightIcon } from "./prShared";
import { CommentableTextDiff } from "./CommentableTextDiff";
import { FileThreadList, groupThreads, type ReviewInteraction } from "./reviewShared";
import type { ReviewComment } from "../../../types";
import { CommentIcon } from "./reviewShared";

/**
 * One expandable per-file diff card. Text files render through the commentable
 * diff (line-hover → inline review threads); semantic (FHR) and binary files keep
 * the manifest-driven viewer, with any anchored review threads listed beneath.
 */
export function PRFileRow({
  token,
  handle,
  repoName,
  prNumber,
  file,
  base,
  headRef,
  repoRef,
  comments,
  review,
}: {
  token: string;
  handle: string;
  repoName: string;
  prNumber: number;
  file: PRFileEntry;
  base: string;
  headRef: string;
  repoRef: RepoRef;
  comments: ReviewComment[];
  review: ReviewInteraction;
}) {
  const fileComments = comments.filter((c) => c.filePath === file.path);
  const threads = groupThreads(fileComments);
  const openThreadCount = threads.filter((t) => !t.root.resolved).length;
  // Auto-expand when a file carries review conversation.
  const [expanded, setExpanded] = useState(threads.length > 0);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const filename = file.path.split("/").pop() ?? file.path;
  const semanticExtensions = useSemanticExtensions();
  const Viewer = resolveFileDiffViewer(filename, semanticExtensions);
  const isSemantic = semanticExtensions?.has(extensionForFilename(filename)) ?? false;

  async function loadDiff() {
    if (loaded || diffLoading) return;
    setDiffLoading(true);
    try {
      const result = await getPRFileDiff(token, handle, repoName, prNumber, file.path);
      setDiff(result.files[0] ?? null);
    } catch {
      setDiff(null);
    } finally {
      setDiffLoading(false);
      setLoaded(true);
    }
  }

  async function toggle() {
    if (!expanded) await loadDiff();
    setExpanded((e) => !e);
  }

  // Load the diff up-front when the card starts expanded (has threads).
  if (expanded && !loaded && !diffLoading) void loadDiff();

  const displayPath =
    file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  const statusTone =
    file.status === "added"
      ? "success"
      : file.status === "deleted"
        ? "danger"
        : file.status === "renamed"
          ? "warning"
          : "neutral";

  return (
    <div className="border border-fh-border rounded-md bg-fh-surface overflow-hidden">
      <div
        className={cx(
          "flex items-center gap-2 px-3 py-2 cursor-pointer select-none bg-fh-canvas hover:bg-fh-surface-muted transition-colors",
          expanded && "border-b border-fh-border",
        )}
        onClick={toggle}
        role="button"
        aria-expanded={expanded}
      >
        <ChevronRightIcon
          size={12}
          className={cx("text-fh-fg-subtle shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <Link
          to={`${base}/blob/${headRef}/${file.path}`}
          className="font-mono text-fh-sm text-fh-accent-fg hover:underline flex-1 min-w-0 truncate no-underline"
          onClick={(e) => e.stopPropagation()}
        >
          {displayPath}
        </Link>
        <div className="flex items-center gap-2 shrink-0 text-fh-xs font-mono">
          {threads.length > 0 && (
            <Badge tone={openThreadCount > 0 ? "accent" : "neutral"} pill={false} className="font-sans gap-1">
              <CommentIcon size={11} />
              {threads.length}
            </Badge>
          )}
          {!file.binary && file.additions > 0 && (
            <span className="text-fh-success-fg font-semibold">+{file.additions}</span>
          )}
          {!file.binary && file.deletions > 0 && (
            <span className="text-fh-danger-fg font-semibold">−{file.deletions}</span>
          )}
          {file.binary && <span className="text-fh-fg-subtle">binary</span>}
          {file.status !== "modified" && (
            <Badge tone={statusTone} pill={false} className="font-sans">
              {file.status}
            </Badge>
          )}
        </div>
      </div>
      {expanded &&
        (diffLoading ? (
          <div className="px-4 py-4 space-y-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} variant="text" width={`${50 + i * 10}%`} />
            ))}
          </div>
        ) : diff && !isSemantic ? (
          <CommentableTextDiff
            file={diff}
            filePath={file.path}
            threads={threads}
            repo={repoRef}
            review={review}
          />
        ) : diff ? (
          <div className="bg-fh-surface">
            <Viewer file={diff} repoBase={base} headRef={headRef} token={token} />
            {threads.length > 0 && (
              <div className="px-4 py-3 border-t border-fh-border">
                <FileThreadList threads={threads} repo={repoRef} review={review} />
              </div>
            )}
          </div>
        ) : threads.length > 0 ? (
          <div className="px-4 py-3">
            <FileThreadList threads={threads} repo={repoRef} review={review} />
          </div>
        ) : (
          <p className="px-4 py-3 text-fh-sm text-fh-fg-muted italic">No diff available.</p>
        ))}
    </div>
  );
}
