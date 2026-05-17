import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getCommit, listCommits } from "../../api";
import type { CommitDetail, CommitInfo } from "../../types";

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

// ─── Commit Detail ────────────────────────────────────────────────────────────

function CommitDetailView({ token, handle, repoName, sha, base }: {
  token: string; handle: string; repoName: string; sha: string; base: string;
}) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getCommit(token, handle, repoName, sha)
      .then(setCommit)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
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
          <div className="ml-auto">
            <code className="font-mono text-sm text-gh-muted bg-gh-canvas border border-gh-border px-2.5 py-1 rounded-md">
              {commit.sha}
            </code>
          </div>
        </div>
      </div>

      {/* Changed files */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-gh-bg border-b border-gh-border flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted">
            <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" />
          </svg>
          <span className="text-sm font-semibold text-gh-text">
            {commit.changedFiles.length} file{commit.changedFiles.length !== 1 ? "s" : ""} changed
          </span>
        </div>
        {commit.changedFiles.length === 0 ? (
          <p className="p-4 text-sm text-gh-muted">No files changed (empty commit)</p>
        ) : (
          <div className="divide-y divide-gh-border">
            {commit.changedFiles.map((file) => (
              <Link
                key={file}
                to={`${base}/blob/${commit.sha}/${file}`}
                className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gh-bg no-underline text-gh-text hover:text-gh-accent group"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
                  <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" />
                </svg>
                <span className="font-mono group-hover:underline">{file}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
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
