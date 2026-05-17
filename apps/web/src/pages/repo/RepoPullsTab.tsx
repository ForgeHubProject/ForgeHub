import { useEffect, useState } from "react";
import { listPulls } from "../../api";
import type { PullRequest, User } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
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

function PRStateIcon({ state }: { state: "open" | "merged" | "closed" }) {
  if (state === "open") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success flex-shrink-0">
        <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
      </svg>
    );
  }
  if (state === "merged") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-purple flex-shrink-0">
        <path fillRule="evenodd" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 9.25v2.378a2.251 2.251 0 1 1-1.5 0V9.25A2.75 2.75 0 0 1 5.45 6.659l-.776-.776a.75.75 0 0 1 1.06-1.06l.716.716v-.385zm.01 5.096a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0zM9.25 5.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-danger flex-shrink-0">
      <path fillRule="evenodd" d="M3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
    </svg>
  );
}

export function RepoPullsTab({ token, handle, repoName, user }: Props) {
  const [stateFilter, setStateFilter] = useState<"open" | "closed">("open");
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load(s: "open" | "closed") {
    setLoading(true);
    setError(null);
    listPulls(token, handle, repoName, s)
      .then((d) => setPulls(d.pulls))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(stateFilter); }, [token, handle, repoName, stateFilter]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button
          className={`text-gh-sm px-3 py-1 rounded-md ${stateFilter === "open" ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
          onClick={() => setStateFilter("open")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="inline mr-1 text-gh-success">
            <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          Open
        </button>
        <button
          className={`text-gh-sm px-3 py-1 rounded-md ${stateFilter === "closed" ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
          onClick={() => setStateFilter("closed")}
        >
          Closed / Merged
        </button>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gh-border">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded mt-0.5" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-2/3" />
                  <div className="h-3 bg-gray-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-gh-danger">{error}</div>
        ) : pulls.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-gh-lg font-semibold text-gh-text">
              {stateFilter === "open" ? "No open pull requests" : "No closed pull requests"}
            </p>
            <p className="text-gh-muted text-gh-sm mt-1">
              Create a new branch and open a pull request to propose changes.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gh-border">
            {pulls.map((pr) => (
              <div key={pr.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gh-bg">
                <PRStateIcon state={pr.state} />
                <div className="flex-1 min-w-0">
                  <p className="text-gh-sm font-semibold text-gh-text truncate">
                    {pr.title}
                  </p>
                  <p className="text-gh-xs text-gh-muted mt-0.5">
                    #{pr.number} {pr.state === "open" ? "opened" : pr.state} {timeAgo(pr.createdAt)} by {pr.author}
                    <span className="mx-1">·</span>
                    <code className="font-mono text-gh-xs">{pr.fromBranch}</code>
                    {" → "}
                    <code className="font-mono text-gh-xs">{pr.toBranch}</code>
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
