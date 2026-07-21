import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getCommit, getCommitDiff, listCommits } from "../../api";
import type { CommitDetail, CommitInfo, FileDiff } from "../../types";
import { resolveFileDiffViewer } from "../../views/fileDiffViewerRegistry";
import { useSemanticExtensions } from "../../lib/fhrFormats";
import { Avatar, Button, EmptyState, Icons, RelativeTime, Skeleton, cx } from "../../ui";
import {
  ChangeTypeBadge,
  ChevronRightIcon,
  CommitNodeIcon,
  DiffCounts,
  DiffStatBar,
  FileIcon,
  ShaChip,
  formatDayHeading,
} from "./commitUi";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  defaultBranch: string;
  splat: string;
};

/** Split a commit message into its subject (first line) and trailing body. */
function splitMessage(commit: { subject: string; message: string }): { subject: string; body: string } {
  const subject = commit.subject;
  const body = commit.message.startsWith(subject)
    ? commit.message.slice(subject.length).trim()
    : commit.message === subject
      ? ""
      : commit.message.trim();
  return { subject, body };
}

function groupByDate(commits: CommitInfo[]): Array<{ date: string; commits: CommitInfo[] }> {
  const order: string[] = [];
  const groups = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const key = formatDayHeading(c.date);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(c);
  }
  return order.map((date) => ({ date, commits: groups.get(date)! }));
}

// ─── File diff card ─────────────────────────────────────────────────────────────
// Restyled CHROME around the manifest-driven diff viewers. The viewer itself
// (text / binary fallback / semantic FHR change-tree + 3D) is resolved and
// rendered unchanged — this only frames it in the shared card anatomy.

export function FileDiffCard({
  file,
  sha,
  base,
  token,
  index,
}: {
  file: FileDiff;
  sha: string;
  base: string;
  token: string;
  index: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const displayPath =
    file.status === "renamed"
      ? `${file.oldPath} → ${file.newPath}`
      : file.status === "deleted"
        ? file.oldPath
        : file.newPath;
  const blobPath = file.status === "deleted" ? file.oldPath : file.newPath;
  const filename = blobPath.split("/").pop() ?? "";
  const semanticExtensions = useSemanticExtensions();
  const Viewer = resolveFileDiffViewer(filename, semanticExtensions);

  return (
    <div id={`diff-${index}`} className="scroll-mt-4 rounded-md border border-fh-border bg-fh-surface">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${displayPath}` : `Expand ${displayPath}`}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((x) => !x);
          }
        }}
        className={cx(
          "sticky top-0 z-10 flex cursor-pointer select-none items-center gap-2 border-b border-fh-border bg-fh-surface-muted px-2.5 py-2",
          expanded ? "rounded-t-md" : "rounded-md border-b-transparent",
        )}
      >
        <span className="flex flex-shrink-0 items-center justify-center text-fh-fg-subtle">
          <ChevronRightIcon size={14} className={cx("transition-transform", expanded && "rotate-90")} />
        </span>
        <FileIcon size={14} className="flex-shrink-0 text-fh-fg-subtle" />
        <Link
          to={`${base}/blob/${sha}/${blobPath}`}
          className="min-w-0 flex-1 truncate font-mono text-fh-sm text-fh-fg no-underline hover:text-fh-accent-fg hover:underline"
          onClick={(e) => e.stopPropagation()}
          title={displayPath}
        >
          {displayPath}
        </Link>
        <div className="flex flex-shrink-0 items-center gap-2.5">
          <DiffCounts additions={file.additions} deletions={file.deletions} />
          <ChangeTypeBadge status={file.status} />
        </div>
      </div>

      {expanded && (
        <div className="overflow-hidden rounded-b-md">
          <Viewer file={file} repoBase={base} headRef={sha} token={token} />
        </div>
      )}
    </div>
  );
}

// ─── Commit detail ──────────────────────────────────────────────────────────────

function CommitDetailView({
  token,
  handle,
  repoName,
  sha,
  base,
}: {
  token: string;
  handle: string;
  repoName: string;
  sha: string;
  base: string;
}) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [diffFiles, setDiffFiles] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setDiffLoading(true);
    setDiffFiles(null);
    setError(null);
    getCommit(token, handle, repoName, sha)
      .then(setCommit)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
    getCommitDiff(token, handle, repoName, sha)
      .then((d) => setDiffFiles(d.files))
      .catch(() => setDiffFiles([]))
      .finally(() => setDiffLoading(false));
  }, [token, handle, repoName, sha]);

  const backLink = (
    <Link
      to={`${base}/commits`}
      className="mb-4 inline-flex items-center gap-1.5 text-fh-sm text-fh-fg-muted no-underline hover:text-fh-accent-fg"
    >
      <Icons.ChevronDownIcon size={14} className="rotate-90" />
      All commits
    </Link>
  );

  if (loading) {
    return (
      <div>
        {backLink}
        <div className="space-y-4">
          <div className="rounded-md border border-fh-border bg-fh-surface">
            <div className="space-y-3 p-4 sm:p-5">
              <Skeleton variant="text" width="55%" height={16} />
              <Skeleton variant="text" width="35%" />
            </div>
            <div className="border-t border-fh-border bg-fh-canvas px-4 py-3 sm:px-5">
              <Skeleton variant="text" width={200} />
            </div>
          </div>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-md border border-fh-border bg-fh-surface">
              <div className="h-10 rounded-t-md border-b border-fh-border bg-fh-surface-muted" />
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3].map((j) => (
                  <Skeleton key={j} variant="text" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div>
        {backLink}
        <div className="rounded-md border border-fh-border bg-fh-surface">
          <EmptyState
            icon={<CommitNodeIcon size={28} />}
            title="Commit not found"
            description={error ?? "This commit could not be loaded."}
            actions={
              <Link to={`${base}/commits`} className="no-underline">
                <Button variant="default">Back to commits</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const { subject, body } = splitMessage(commit);
  const totalAdditions = diffFiles?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = diffFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0;
  const fileCount = diffFiles?.length ?? 0;

  return (
    <div>
      {backLink}

      {/* Commit header card */}
      <div className="mb-4 rounded-md border border-fh-border bg-fh-surface">
        <div className="p-4 sm:p-5">
          <h2 className="text-fh-lg font-semibold leading-snug text-fh-fg break-words">{subject}</h2>
          {body && (
            <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-fh-sm leading-relaxed text-fh-fg-muted">
              {body}
            </pre>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-fh-border bg-fh-canvas px-4 py-3 text-fh-sm sm:px-5">
          <Avatar name={commit.authorName} size={20} title={commit.authorEmail} />
          <span className="font-semibold text-fh-fg">{commit.authorName}</span>
          <span className="text-fh-fg-muted">
            committed <RelativeTime date={commit.date} />
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
            {commit.parents.length > 0 && (
              <span className="flex items-center gap-1.5 text-fh-sm text-fh-fg-muted">
                <span>{commit.parents.length > 1 ? "parents" : "parent"}</span>
                {commit.parents.map((p) => (
                  <Link
                    key={p}
                    to={`${base}/commits/${p}`}
                    className="font-mono text-fh-xs text-fh-accent-fg no-underline hover:underline"
                  >
                    {p.slice(0, 7)}
                  </Link>
                ))}
              </span>
            )}
            <ShaChip sha={commit.sha} />
          </div>
        </div>
      </div>

      {/* Diff */}
      {diffLoading ? (
        <div className="space-y-4">
          {[...Array(commit.changedFiles.length || 2)].map((_, i) => (
            <div key={i} className="rounded-md border border-fh-border bg-fh-surface">
              <div className="h-10 rounded-t-md border-b border-fh-border bg-fh-surface-muted" />
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3].map((j) => (
                  <Skeleton key={j} variant="text" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : diffFiles && diffFiles.length > 0 ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-fh-sm text-fh-fg-muted">
            <span className="font-semibold text-fh-fg">
              {fileCount} changed file{fileCount !== 1 ? "s" : ""}
            </span>
            <DiffCounts additions={totalAdditions} deletions={totalDeletions} />
            <DiffStatBar additions={totalAdditions} deletions={totalDeletions} />
          </div>
          <div className="space-y-4">
            {diffFiles.map((file, i) => (
              <FileDiffCard key={i} file={file} sha={sha} base={base} token={token} index={i} />
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-fh-border bg-fh-surface">
          <EmptyState
            icon={<FileIcon size={28} />}
            title={commit.changedFiles.length === 0 ? "Empty commit" : "Diff unavailable"}
            description={
              commit.changedFiles.length === 0
                ? "This commit doesn't change any files."
                : "The diff for this commit could not be loaded."
            }
          />
        </div>
      )}
    </div>
  );
}

// ─── Commit row ─────────────────────────────────────────────────────────────────

function CommitRow({ commit, base }: { commit: CommitInfo; base: string }) {
  const { subject, body } = splitMessage(commit);
  const [open, setOpen] = useState(false);

  return (
    <div className="group flex items-start gap-3 px-3 py-3 transition-colors hover:bg-fh-surface-muted/50 sm:px-4">
      <Avatar name={commit.authorName} size={28} className="mt-0.5" title={commit.authorEmail} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <Link
            to={`${base}/commits/${commit.sha}`}
            className="text-fh-base font-semibold leading-snug text-fh-fg no-underline break-words hover:text-fh-accent-fg"
          >
            {subject}
          </Link>
          {body && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label="Toggle commit description"
              className={cx(
                "mt-0.5 inline-flex h-5 flex-shrink-0 items-center rounded border px-1.5 text-fh-fg-muted transition-colors",
                open
                  ? "border-fh-border-strong bg-fh-surface-muted"
                  : "border-fh-border bg-fh-surface-muted hover:border-fh-border-strong",
              )}
            >
              <span className="text-[13px] leading-none tracking-tight">…</span>
            </button>
          )}
        </div>
        {open && body && (
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-fh-surface-muted px-3 py-2 font-sans text-fh-sm leading-relaxed text-fh-fg-muted">
            {body}
          </pre>
        )}
        <div className="mt-1 flex items-center gap-1.5 text-fh-sm text-fh-fg-muted">
          <span className="font-medium text-fh-fg-muted">{commit.authorName}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime date={commit.date} />
        </div>
      </div>
      <div className="flex-shrink-0 pt-0.5">
        <ShaChip sha={commit.sha} />
      </div>
    </div>
  );
}

// ─── Commits list ───────────────────────────────────────────────────────────────

function CommitsList({ token, handle, repoName, defaultBranch, base }: Props & { base: string }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listCommits(token, handle, repoName, defaultBranch, undefined, 50)
      .then((d) => setCommits(d.commits))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, defaultBranch]);

  if (loading) {
    return (
      <div className="space-y-6">
        {[0, 1].map((g) => (
          <div key={g}>
            <Skeleton variant="text" width={150} height={14} className="mb-3 ml-8" />
            <div className="ml-8 divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton variant="circle" width={28} height={28} />
                  <div className="flex-1 space-y-2">
                    <Skeleton variant="text" width="55%" />
                    <Skeleton variant="text" width="30%" />
                  </div>
                  <Skeleton width={74} height={26} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-fh-border bg-fh-surface">
        <EmptyState
          icon={<CommitNodeIcon size={28} />}
          title="Couldn't load commits"
          description="This repository may not have any commits yet, or the branch is unavailable."
        />
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="rounded-md border border-fh-border bg-fh-surface">
        <EmptyState
          icon={<CommitNodeIcon size={28} />}
          title="No commits yet"
          description="Push your first commit to see the history here."
        />
      </div>
    );
  }

  const groups = groupByDate(commits);

  return (
    <div>
      <div className="mb-4 flex items-center gap-1.5 text-fh-sm text-fh-fg-muted">
        <CommitNodeIcon size={16} className="text-fh-fg-subtle" />
        <span>Commits on</span>
        <span className="rounded-full border border-fh-border bg-fh-surface-muted px-2 py-0.5 font-mono text-fh-xs text-fh-fg">
          {defaultBranch}
        </span>
      </div>

      <ol className="relative space-y-6 before:absolute before:bottom-3 before:left-[9px] before:top-3 before:w-px before:bg-fh-border">
        {groups.map(({ date, commits: dayCommits }) => (
          <li key={date}>
            <h3 className="relative mb-3 flex items-center gap-2">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-fh-canvas text-fh-fg-subtle ring-4 ring-fh-canvas">
                <CommitNodeIcon size={16} />
              </span>
              <span className="text-fh-sm font-semibold text-fh-fg">Commits on {date}</span>
            </h3>
            <div className="ml-8 divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
              {dayCommits.map((commit) => (
                <CommitRow key={commit.sha} commit={commit} base={base} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Main export ────────────────────────────────────────────────────────────────

export function RepoCommitsTab({ token, handle, repoName, defaultBranch, splat }: Props) {
  const base = `/${handle}/${repoName}`;
  const match = splat.match(/^commits\/([0-9a-f]{4,40})$/i);
  if (match) {
    return <CommitDetailView token={token} handle={handle} repoName={repoName} sha={match[1]} base={base} />;
  }
  return <CommitsList token={token} handle={handle} repoName={repoName} defaultBranch={defaultBranch} splat={splat} base={base} />;
}
