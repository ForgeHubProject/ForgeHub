import { useEffect, useState } from "react";
import { listCommits } from "../../api";
import type { CommitInfo } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  defaultBranch: string;
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
  const groups: Map<string, CommitInfo[]> = new Map();
  for (const c of commits) {
    const date = new Date(c.date).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    });
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(c);
  }
  return Array.from(groups.entries()).map(([date, commits]) => ({ date, commits }));
}

export function RepoCommitsTab({ token, handle, repoName, defaultBranch }: Props) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listCommits(token, handle, repoName, defaultBranch, undefined, 50)
      .then((d) => setCommits(d.commits))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, defaultBranch]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="card p-4 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
            <div className="h-3 bg-gray-100 rounded w-1/3" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-8 text-center">
        <p className="text-gh-danger">{error}</p>
        <p className="text-gh-muted text-gh-sm mt-2">This repository may not have any commits yet.</p>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="card p-12 text-center">
        <p className="text-gh-lg font-semibold text-gh-text">No commits yet</p>
        <p className="text-gh-muted text-gh-sm mt-2">Push your first commit to see history here.</p>
      </div>
    );
  }

  const groups = groupByDate(commits);

  return (
    <div className="space-y-6">
      {groups.map(({ date, commits: dayCommits }) => (
        <div key={date}>
          <h3 className="text-gh-sm font-semibold text-gh-muted mb-2 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M4.75 0a.75.75 0 01.75.75V2h5V.75a.75.75 0 011.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0113.25 16H2.75A1.75 1.75 0 011 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 014.75 0zm0 3.5h-2a.25.25 0 00-.25.25V6h10.5V3.75a.25.25 0 00-.25-.25h-2V5a.75.75 0 01-1.5 0V3.5h-5V5a.75.75 0 01-1.5 0V3.5zM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25V7.5H2.5z" />
            </svg>
            Commits on {date}
          </h3>
          <div className="card divide-y divide-gh-border overflow-hidden">
            {dayCommits.map((commit) => (
              <div key={commit.sha} className="flex items-start gap-3 px-4 py-3 hover:bg-gh-bg group">
                <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-gh-xs flex-shrink-0 mt-0.5">
                  {commit.authorName[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-gh-sm font-semibold text-gh-text truncate" title={commit.message}>
                    {commit.subject}
                  </p>
                  <p className="text-gh-xs text-gh-muted mt-0.5">
                    {commit.authorName} committed {timeAgo(commit.date)}
                  </p>
                </div>
                <code className="font-mono text-gh-xs text-gh-muted bg-gh-bg border border-gh-border px-2 py-0.5 rounded flex-shrink-0 group-hover:border-gh-accent group-hover:text-gh-accent cursor-pointer">
                  {commit.shortSha}
                </code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
