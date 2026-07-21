import { useState } from "react";
import { Link } from "react-router-dom";
import { getPRFileDiff } from "../../../api";
import type { FileDiff, PRFileEntry } from "../../../types";
import { resolveFileDiffViewer } from "../../../views/fileDiffViewerRegistry";
import { useSemanticExtensions } from "../../../lib/fhrFormats";
import { Badge, Skeleton, cx } from "../../../ui";
import { ChevronRightIcon } from "./prShared";

/**
 * One expandable per-file diff card. The chrome (header, counts, status,
 * expand/collapse) is restyled to tokens; the diff body is still rendered by the
 * manifest-driven viewer registry — semantic (FHR) viewers included — so the
 * wiring is untouched and only framed natively here.
 */
export function PRFileRow({
  token,
  handle,
  repoName,
  prNumber,
  file,
  base,
  headRef,
}: {
  token: string;
  handle: string;
  repoName: string;
  prNumber: number;
  file: PRFileEntry;
  base: string;
  headRef: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const filename = file.path.split("/").pop() ?? file.path;
  const semanticExtensions = useSemanticExtensions();
  const Viewer = resolveFileDiffViewer(filename, semanticExtensions);

  async function toggle() {
    if (!expanded && !diff) {
      setDiffLoading(true);
      try {
        const result = await getPRFileDiff(token, handle, repoName, prNumber, file.path);
        setDiff(result.files[0] ?? null);
      } catch {
        setDiff(null);
      } finally {
        setDiffLoading(false);
      }
    }
    setExpanded((e) => !e);
  }

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
        ) : diff ? (
          <div className="bg-fh-surface">
            <Viewer file={diff} repoBase={base} headRef={headRef} token={token} />
          </div>
        ) : (
          <p className="px-4 py-3 text-fh-sm text-fh-fg-muted italic">No diff available.</p>
        ))}
    </div>
  );
}
