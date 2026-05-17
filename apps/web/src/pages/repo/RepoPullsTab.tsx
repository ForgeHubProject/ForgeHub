import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { closePull, getPull, listCommits, listPulls, mergePull } from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { CommitInfo, PullRequest, User } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0" style={{ color: "#8250df" }}>
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

function stateColor(state: "open" | "merged" | "closed") {
  if (state === "open") return "#1a7f37";
  if (state === "merged") return "#8250df";
  return "#cf222e";
}

// ─── PR Detail ───────────────────────────────────────────────────────────────

function PullDetail({ token, handle, repoName, user, number }: {
  token: string; handle: string; repoName: string; user: User; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [pr, setPr] = useState<PullRequest | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPull(token, handle, repoName, number)
      .then((p) => {
        setPr(p);
        return listCommits(token, handle, repoName, p.fromBranch, undefined, 20);
      })
      .then((c) => setCommits(c.commits))
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  async function merge() {
    if (!pr) return;
    setMerging(true);
    setError(null);
    try {
      await mergePull(token, handle, repoName, number);
      setPr((p) => p ? { ...p, state: "merged", mergedAt: new Date().toISOString() } : p);
      setActionMsg("Pull request merged successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  async function close() {
    if (!pr) return;
    setClosing(true);
    try {
      await closePull(token, handle, repoName, number);
      setPr((p) => p ? { ...p, state: "closed" } : p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setClosing(false);
    }
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-3/4" />
        <div className="h-4 bg-gray-100 rounded w-1/4" />
        <div className="card p-6 space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-4 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (error && !pr) {
    return (
      <div className="card p-8 text-center">
        <p className="text-gh-danger">{error}</p>
        <button className="btn-default mt-4" onClick={() => navigate(`${base}/pulls`)}>← Back to pull requests</button>
      </div>
    );
  }

  if (!pr) return null;

  const isOpen = pr.state === "open";

  return (
    <div>
      <Link to={`${base}/pulls`} className="inline-flex items-center gap-1.5 text-sm text-gh-muted hover:text-gh-accent mb-4 no-underline">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z" /></svg>
        Pull requests
      </Link>

      <h1 className="text-2xl font-semibold text-gh-text mb-3 leading-tight">
        {pr.title}
        <span className="text-gh-muted font-light ml-2">#{pr.number}</span>
      </h1>

      {/* Status row */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full text-white"
          style={{ backgroundColor: stateColor(pr.state) }}
        >
          <PRStateIcon state={pr.state} />
          {pr.state === "open" ? "Open" : pr.state === "merged" ? "Merged" : "Closed"}
        </span>
        <span className="text-sm text-gh-muted">
          <span className="font-semibold text-gh-text">{pr.author}</span>
          {" wants to merge into "}
          <code className="font-mono text-xs bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded">{pr.toBranch}</code>
          {" from "}
          <code className="font-mono text-xs bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded">{pr.fromBranch}</code>
          {" · "}
          {timeAgo(pr.createdAt)}
        </span>
      </div>

      <div className="flex gap-6">
        {/* Main */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Description */}
          <div className="card overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border bg-gh-bg text-sm">
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {pr.author[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text">{pr.author}</span>
              <span className="text-gh-muted">opened {timeAgo(pr.createdAt)}</span>
            </div>
            <div className="px-6 py-5">
              {pr.description ? (
                <MarkdownRenderer content={pr.description} />
              ) : (
                <p className="text-gh-muted text-sm italic">No description provided.</p>
              )}
            </div>
          </div>

          {/* Commits */}
          {commits.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gh-muted mb-2 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" /></svg>
                {commits.length} commit{commits.length !== 1 ? "s" : ""} from <code className="font-mono text-xs">{pr.fromBranch}</code>
              </h3>
              <div className="card divide-y divide-gh-border overflow-hidden">
                {commits.map((c) => (
                  <div key={c.sha} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gh-bg text-sm">
                    <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {c.authorName[0]?.toUpperCase()}
                    </div>
                    <span className="flex-1 min-w-0 truncate text-gh-text">{c.subject}</span>
                    <code className="font-mono text-xs text-gh-muted bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded flex-shrink-0">
                      {c.shortSha}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Merge box */}
          {isOpen && (
            <div className="card p-5">
              {error && <p className="text-gh-danger text-sm mb-3">{error}</p>}
              {actionMsg && <p className="text-gh-success text-sm mb-3">{actionMsg}</p>}
              <div className="flex items-center gap-3">
                <button
                  className="btn-primary px-4 flex items-center gap-2"
                  onClick={merge}
                  disabled={merging || pr.mergeable === false}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 9.25v2.378a2.251 2.251 0 1 1-1.5 0V9.25A2.75 2.75 0 0 1 5.45 6.659l-.776-.776a.75.75 0 0 1 1.06-1.06l.716.716v-.385zm.01 5.096a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0zM9.25 5.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" /></svg>
                  {merging ? "Merging…" : "Merge pull request"}
                </button>
                {pr.mergeable === false && (
                  <span className="text-sm text-gh-danger">This branch has conflicts that must be resolved.</span>
                )}
                <button
                  className="btn-danger text-sm ml-auto"
                  onClick={close}
                  disabled={closing}
                >
                  {closing ? "Closing…" : "Close pull request"}
                </button>
              </div>
            </div>
          )}

          {pr.state === "merged" && (
            <div className="card p-5 flex items-center gap-3" style={{ backgroundColor: "#fbefff", borderColor: "#d8b4fe" }}>
              <PRStateIcon state="merged" />
              <p className="text-sm font-medium" style={{ color: "#8250df" }}>
                Pull request merged {pr.mergedAt ? timeAgo(pr.mergedAt) : ""}
              </p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="w-56 flex-shrink-0 hidden lg:block text-sm">
          <div className="border-b border-gh-border pb-3 mb-3">
            <p className="font-semibold text-gh-text mb-2">Reviewers</p>
            <p className="text-xs text-gh-muted">No reviewers assigned</p>
          </div>
          <div>
            <p className="font-semibold text-gh-text mb-2">Labels</p>
            <p className="text-xs text-gh-muted">None yet</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── PR List ─────────────────────────────────────────────────────────────────

function PullsList({ token, handle, repoName, user }: Omit<Props, "splat">) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const [stateFilter, setStateFilter] = useState<"open" | "closed">("open");
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listPulls(token, handle, repoName, stateFilter)
      .then((d) => setPulls(d.pulls))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, stateFilter]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {(["open", "closed"] as const).map((s) => (
          <button
            key={s}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${stateFilter === s ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
            onClick={() => setStateFilter(s)}
          >
            <PRStateIcon state={s === "open" ? "open" : "closed"} />
            {s === "open" ? "Open" : "Closed / Merged"}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gh-border">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded mt-0.5" />
                <div className="flex-1 space-y-2"><div className="h-4 bg-gray-200 rounded w-2/3" /><div className="h-3 bg-gray-100 rounded w-1/3" /></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-gh-danger">{error}</div>
        ) : pulls.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-lg font-semibold text-gh-text">{stateFilter === "open" ? "No open pull requests" : "No closed pull requests"}</p>
            <p className="text-gh-muted text-sm mt-1">Create a branch and open a pull request to propose changes.</p>
          </div>
        ) : (
          <div className="divide-y divide-gh-border">
            {pulls.map((pr) => (
              <button
                key={pr.id}
                className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-gh-bg transition-colors"
                onClick={() => navigate(`${base}/pulls/${pr.number}`)}
              >
                <PRStateIcon state={pr.state} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gh-text truncate">{pr.title}</p>
                  <p className="text-xs text-gh-muted mt-0.5">
                    #{pr.number} {pr.state === "open" ? "opened" : pr.state} {timeAgo(pr.createdAt)} by {pr.author}
                    <span className="mx-1">·</span>
                    <code className="font-mono">{pr.fromBranch}</code> → <code className="font-mono">{pr.toBranch}</code>
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function RepoPullsTab({ token, handle, repoName, user, splat }: Props) {
  const match = splat.match(/^pulls\/(\d+)$/);
  if (match) {
    return <PullDetail token={token} handle={handle} repoName={repoName} user={user} number={Number(match[1])} />;
  }
  return <PullsList token={token} handle={handle} repoName={repoName} user={user} />;
}
