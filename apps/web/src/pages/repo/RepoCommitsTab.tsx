import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getCommit, getCommitDiff, listCommits } from "../../api";
import type { CommitDetail, CommitInfo, FileDiff } from "../../types";
import { resolveFileDiffViewer } from "../../views/fileDiffViewerRegistry";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  defaultBranch: string;
  splat: string;
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function groupByDate(commits: CommitInfo[]): Array<{ date: string; commits: CommitInfo[] }> {
  const groups = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const date = new Date(c.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(c);
  }
  return Array.from(groups.entries()).map(([date, commits]) => ({ date, commits }));
}

// ─── Diff Viewer ──────────────────────────────────────────────────────────────

function FileDiffCard({ file, sha, base, token }: { file: FileDiff; sha: string; base: string; token: string }) {
  const [expanded, setExpanded] = useState(true);
  const displayPath = file.status === "renamed"
    ? `${file.oldPath} → ${file.newPath}`
    : file.status === "deleted" ? file.oldPath : file.newPath;
  const blobPath = file.status === "deleted" ? file.oldPath : file.newPath;
  const filename = blobPath.split("/").pop() ?? "";
  const Viewer = resolveFileDiffViewer(filename);

  return (
    <div className="card overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 bg-gh-bg border-b border-gh-border cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="currentColor"
          className="text-gh-muted flex-shrink-0 transition-transform"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <path fillRule="evenodd" d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
        </svg>
        <Link
          to={`${base}/blob/${sha}/${blobPath}`}
          className="font-mono text-sm text-gh-accent hover:underline flex-1 min-w-0 truncate no-underline"
          onClick={(e) => e.stopPropagation()}
        >
          {displayPath}
        </Link>
        <div className="flex items-center gap-2 flex-shrink-0 text-xs font-mono">
          {file.additions > 0 && <span className="text-green-600">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-red-600">-{file.deletions}</span>}
          {file.status !== "modified" && (
            <span className="px-1.5 py-0.5 rounded text-xs font-semibold"
              style={{
                backgroundColor: file.status === "added" ? "#dafbe1" : file.status === "deleted" ? "#ffd7d5" : "#fff8c5",
                color: file.status === "added" ? "#1a7f37" : file.status === "deleted" ? "#cf222e" : "#9a6700",
              }}
            >
              {file.status}
            </span>
          )}
        </div>
      </div>

      {expanded && <Viewer file={file} repoBase={base} headRef={sha} token={token} />}
    </div>
  );
}

// ─── Commit Detail ────────────────────────────────────────────────────────────

function CommitDetailView({ token, handle, repoName, sha, base }: {
  token: string; handle: string; repoName: string; sha: string; base: string;
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
    getCommit(token, handle, repoName, sha)
      .then(setCommit)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
    getCommitDiff(token, handle, repoName, sha)
      .then((d) => setDiffFiles(d.files))
      .catch(() => setDiffFiles([]))
      .finally(() => setDiffLoading(false));
  }, [token, handle, repoName, sha]);

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-6 bg-gray-200 rounded w-2/3" />
        <div className="card p-4 space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-4 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div className="card p-8 text-center">
        <p className="text-gh-danger">{error ?? "Commit not found"}</p>
        <Link to={`${base}/commits`} className="btn-default mt-4 inline-flex no-underline">← Back to commits</Link>
      </div>
    );
  }

  const totalAdditions = diffFiles?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = diffFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <div>
      <Link to={`${base}/commits`} className="inline-flex items-center gap-1.5 text-sm text-gh-muted hover:text-gh-accent mb-4 no-underline">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z" /></svg>
        Commits
      </Link>

      {/* Commit header */}
      <div className="card overflow-hidden mb-4">
        <div className="p-5 border-b border-gh-border">
          <p className="text-xl font-semibold text-gh-text mb-1">{commit.subject}</p>
          {commit.message !== commit.subject && (
            <pre className="text-sm text-gh-muted font-sans whitespace-pre-wrap mt-2">
              {commit.message.slice(commit.subject.length).trim()}
            </pre>
          )}
        </div>
        <div className="px-5 py-3 bg-gh-bg flex items-center gap-4 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
              {commit.authorName[0]?.toUpperCase()}
            </div>
            <span className="font-semibold text-gh-text">{commit.authorName}</span>
            <span className="text-gh-muted">{commit.authorEmail}</span>
          </div>
          <span className="text-gh-muted">{timeAgo(commit.date)}</span>
          <code className="ml-auto font-mono text-sm text-gh-muted bg-gh-canvas border border-gh-border px-2.5 py-1 rounded-md">
            {commit.sha.slice(0, 7)}
          </code>
        </div>
      </div>

      {/* Diff section */}
      {diffLoading ? (
        <div className="space-y-3">
          {[...Array(commit.changedFiles.length || 2)].map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="px-4 py-2.5 bg-gh-bg border-b border-gh-border h-9" />
              <div className="p-4 space-y-1">
                {[...Array(4)].map((_, j) => <div key={j} className="h-4 bg-gray-100 rounded" />)}
              </div>
            </div>
          ))}
        </div>
      ) : diffFiles && diffFiles.length > 0 ? (
        <>
          <div className="flex items-center gap-3 mb-3 text-sm text-gh-muted">
            <span>{diffFiles.length} file{diffFiles.length !== 1 ? "s" : ""} changed</span>
            {totalAdditions > 0 && <span className="text-green-600 font-mono">+{totalAdditions}</span>}
            {totalDeletions > 0 && <span className="text-red-600 font-mono">-{totalDeletions}</span>}
          </div>
          <div className="space-y-3">
            {diffFiles.map((file, i) => (
              <FileDiffCard key={i} file={file} sha={sha} base={base} token={token} />
            ))}
          </div>
        </>
      ) : (
        <div className="card p-8 text-center text-gh-muted text-sm">
          {commit.changedFiles.length === 0 ? "Empty commit — no files changed." : "Could not load diff."}
        </div>
      )}
    </div>
  );
}

// ─── Commits List ─────────────────────────────────────────────────────────────

function CommitsList({ token, handle, repoName, defaultBranch, base }: Props & { base: string }) {
  const navigate = useNavigate();
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listCommits(token, handle, repoName, defaultBranch, undefined, 50)
      .then((d) => setCommits(d.commits))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, defaultBranch]);

  if (loading) {
    return (
      <div className="space-y-6">
        {[...Array(2)].map((_, g) => (
          <div key={g}>
            <div className="h-4 bg-gray-100 rounded w-40 mb-2" />
            <div className="card divide-y divide-gh-border overflow-hidden animate-pulse">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-6 h-6 bg-gray-200 rounded-full" />
                  <div className="flex-1 space-y-1">
                    <div className="h-4 bg-gray-200 rounded w-2/3" />
                    <div className="h-3 bg-gray-100 rounded w-1/3" />
                  </div>
                  <div className="w-16 h-6 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="card p-8 text-center"><p className="text-gh-danger">{error}</p><p className="text-gh-muted text-sm mt-2">This repository may not have any commits yet.</p></div>;
  }

  if (commits.length === 0) {
    return <div className="card p-16 text-center"><p className="text-xl font-semibold text-gh-text">No commits yet</p><p className="text-gh-muted text-sm mt-2">Push your first commit to see history here.</p></div>;
  }

  const groups = groupByDate(commits);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-gh-muted">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
        </svg>
        Commits on
        <code className="font-mono text-xs bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded text-gh-text">{defaultBranch}</code>
      </div>
      {groups.map(({ date, commits: dayCommits }) => (
        <div key={date}>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gh-muted mb-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M4.75 0a.75.75 0 01.75.75V2h5V.75a.75.75 0 011.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0113.25 16H2.75A1.75 1.75 0 011 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 014.75 0zm0 3.5h-2a.25.25 0 00-.25.25V6h10.5V3.75a.25.25 0 00-.25-.25h-2V5a.75.75 0 01-1.5 0V3.5h-5V5a.75.75 0 01-1.5 0V3.5zM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25V7.5H2.5z" /></svg>
            Commits on {date}
          </h3>
          <div className="card divide-y divide-gh-border overflow-hidden">
            {dayCommits.map((commit) => (
              <div key={commit.sha} className="flex items-center gap-3 px-4 py-3 hover:bg-gh-bg group">
                <div className="w-7 h-7 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {commit.authorName[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gh-text truncate">{commit.subject}</p>
                  <p className="text-xs text-gh-muted mt-0.5">
                    {commit.authorName} · {timeAgo(commit.date)}
                  </p>
                </div>
                <button
                  className="font-mono text-xs text-gh-muted bg-gh-canvas border border-gh-border px-2 py-1 rounded-md flex-shrink-0 hover:border-gh-accent hover:text-gh-accent transition-colors"
                  onClick={() => navigate(`${base}/commits/${commit.sha}`)}
                  title="View commit"
                >
                  {commit.shortSha}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function RepoCommitsTab({ token, handle, repoName, defaultBranch, splat }: Props) {
  const base = `/${handle}/${repoName}`;
  const match = splat.match(/^commits\/([0-9a-f]{4,40})$/i);
  if (match) {
    return <CommitDetailView token={token} handle={handle} repoName={repoName} sha={match[1]} base={base} />;
  }
  return <CommitsList token={token} handle={handle} repoName={repoName} defaultBranch={defaultBranch} splat={splat} base={base} />;
}
