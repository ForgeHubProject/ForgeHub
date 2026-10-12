import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getCheckSummary, listCommits } from "../../api";
import type { CheckSummary, CommitInfo } from "../../types";
import { RelativeTime } from "../../ui";
import { CheckStatusIcon, checkState } from "./ci/ciShared";

export function HistoryGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-fh-fg-muted shrink-0" aria-hidden="true">
      <path fillRule="evenodd" d="M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z" />
    </svg>
  );
}

/**
 * Where a path's history lives: the Commits tab filtered to it (#224). No path
 * is the whole branch's history.
 */
export function historyUrl(base: string, ref: string, path?: string): string {
  const qs = new URLSearchParams({ ref });
  if (path) qs.set("path", path);
  return `${base}/commits?${qs}`;
}

/**
 * GitHub's bar about one file (#224): its last commit's author, message (linked),
 * check status, short hash and time, and a History button for that file's
 * commits. The commit is the file's own, not the branch's: the commits API
 * filters by path (#109).
 */
export function LatestCommitBar({ token, handle, repoName, gitRef, path, base }: {
  token: string | null;
  handle: string;
  repoName: string;
  gitRef: string;
  path: string;
  base: string;
}) {
  const [commit, setCommit] = useState<CommitInfo | null | undefined>(undefined);
  const [status, setStatus] = useState<CheckSummary | null>(null);

  useEffect(() => {
    let live = true;
    setCommit(undefined);
    setStatus(null);
    listCommits(token, handle, repoName, gitRef, { path, perPage: 1 })
      .then(({ commits }) => {
        if (!live) return;
        const head = commits[0] ?? null;
        setCommit(head);
        if (head) {
          getCheckSummary(token, handle, repoName, head.sha)
            .then((s) => { if (live) setStatus(s); })
            .catch(() => { /* no checks */ });
        }
      })
      .catch(() => { if (live) setCommit(null); });
    return () => { live = false; };
  }, [token, handle, repoName, gitRef, path]);

  return (
    <div className="mb-3 flex min-h-[42px] items-center gap-3 rounded-md border border-fh-border bg-fh-canvas px-4 py-2 text-fh-sm">
      {commit === undefined ? (
        <span className="text-fh-fg-subtle">Loading the latest commit…</span>
      ) : commit === null ? (
        <span className="text-fh-fg-subtle">No commit information for this file.</span>
      ) : (
        <>
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fh-accent-emphasis text-fh-xs font-semibold text-fh-on-emphasis">
            {commit.authorName[0]?.toUpperCase()}
          </span>
          <span className="max-w-[160px] truncate font-semibold text-fh-fg">{commit.authorName}</span>
          <Link
            to={`${base}/commits/${commit.sha}`}
            className="min-w-0 flex-1 truncate text-fh-fg-muted no-underline hover:text-fh-accent-fg hover:underline"
            title={commit.subject}
          >
            {commit.subject}
          </Link>
          {status && (
            <Link to={`${base}/actions`} className="inline-flex shrink-0 items-center no-underline" title="View workflow runs" aria-label="Commit checks">
              <CheckStatusIcon state={checkState(status)} size={15} />
            </Link>
          )}
          <Link
            to={`${base}/commits/${commit.sha}`}
            className="hidden shrink-0 rounded border border-fh-border bg-fh-surface px-1.5 py-0.5 font-mono text-fh-xs text-fh-fg-muted no-underline transition-colors hover:border-fh-border-strong hover:text-fh-accent-fg sm:block"
            title={`View commit ${commit.sha}`}
          >
            {commit.shortSha}
          </Link>
          <RelativeTime date={commit.date} className="hidden shrink-0 text-fh-xs text-fh-fg-subtle md:block" />
        </>
      )}
      <Link
        to={historyUrl(base, gitRef, path)}
        className="ml-auto inline-flex shrink-0 items-center gap-1 text-fh-xs font-semibold text-fh-fg no-underline hover:text-fh-accent-fg"
        title={`Commits that changed ${path}`}
      >
        <HistoryGlyph />
        History
      </Link>
    </div>
  );
}
