import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createIssue, createIssueComment, getIssue,
  listIssueComments, listIssues, updateIssue
} from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { Issue, IssueComment, User } from "../../types";

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

function OpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function ClosedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-purple-600">
      <path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" />
      <path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
    </svg>
  );
}

// ─── Issue Detail ─────────────────────────────────────────────────────────────

function IssueDetail({ token, handle, repoName, user, number }: {
  token: string; handle: string; repoName: string; user: User; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getIssue(token, handle, repoName, number),
      listIssueComments(token, handle, repoName, number),
    ])
      .then(([iss, cmts]) => { setIssue(iss); setComments(cmts.comments); })
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmitting(true);
    try {
      const c = await createIssueComment(token, handle, repoName, number, commentBody.trim());
      setComments((prev) => [...prev, c]);
      setCommentBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleState() {
    if (!issue) return;
    setToggling(true);
    try {
      const updated = await updateIssue(token, handle, repoName, number, {
        state: issue.state === "open" ? "closed" : "open",
      });
      setIssue(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-2/3" />
        <div className="h-4 bg-gray-100 rounded w-1/3" />
        <div className="card p-6 space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-4 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="card p-8 text-center">
        <p className="text-gh-danger">{error ?? "Issue not found"}</p>
        <button className="btn-default mt-4" onClick={() => navigate(`${base}/issues`)}>← Back to issues</button>
      </div>
    );
  }

  const isOpen = issue.state === "open";
  const isAuthor = issue.author === user.handle;

  return (
    <div>
      {/* Back link */}
      <Link to={`${base}/issues`} className="inline-flex items-center gap-1.5 text-sm text-gh-muted hover:text-gh-accent mb-4 no-underline">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path fillRule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z" />
        </svg>
        Issues
      </Link>

      {/* Title */}
      <div className="flex items-start gap-3 mb-4">
        <h1 className="text-2xl font-semibold text-gh-text flex-1 leading-tight">
          {issue.title}
          <span className="text-gh-muted font-light ml-2">#{issue.number}</span>
        </h1>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full text-white"
          style={{ backgroundColor: isOpen ? "#1a7f37" : "#8250df" }}
        >
          {isOpen ? <OpenIcon /> : <ClosedIcon />}
          {isOpen ? "Open" : "Closed"}
        </span>
        <span className="text-sm text-gh-muted">
          <span className="font-semibold text-gh-text">{issue.author}</span>
          {" opened this issue "}
          {timeAgo(issue.createdAt)}
          {" · "}
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6">
        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Opening post */}
          <div className="card overflow-hidden">
            <div
              className="flex items-center gap-3 px-4 py-2 border-b border-gh-border text-sm"
              style={{ backgroundColor: "#ddf4ff" }}
            >
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {issue.author[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text">{issue.author}</span>
              <span className="text-gh-muted">commented {timeAgo(issue.createdAt)}</span>
            </div>
            <div className="px-6 py-5">
              {issue.body ? (
                <MarkdownRenderer content={issue.body} />
              ) : (
                <p className="text-gh-muted text-sm italic">No description provided.</p>
              )}
            </div>
          </div>

          {/* Comments */}
          {comments.map((c) => (
            <div key={c.id} className="card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border bg-gh-bg text-sm">
                <div className="w-6 h-6 rounded-full bg-gray-400 flex items-center justify-center text-white text-xs font-bold">
                  {c.author[0]?.toUpperCase()}
                </div>
                <span className="font-semibold text-gh-text">{c.author}</span>
                <span className="text-gh-muted">commented {timeAgo(c.createdAt)}</span>
              </div>
              <div className="px-6 py-5">
                <MarkdownRenderer content={c.body} />
              </div>
            </div>
          ))}

          {/* Close/reopen divider */}
          {(isAuthor) && (
            <div className="flex items-center gap-3 pt-2">
              <div className="flex-1 h-px bg-gh-border" />
              <button
                className={isOpen ? "btn-danger text-sm" : "btn-default text-sm"}
                onClick={toggleState}
                disabled={toggling}
              >
                {toggling ? "Updating…" : isOpen ? "Close issue" : "Reopen issue"}
              </button>
            </div>
          )}

          {/* New comment */}
          <form onSubmit={submitComment} className="card overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border bg-gh-bg text-sm">
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {user.handle[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text">{user.handle}</span>
            </div>
            <div className="p-4">
              <textarea
                className="input resize-none h-28 font-mono text-sm"
                placeholder="Leave a comment…"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              {error && <p className="text-gh-danger text-sm mt-2">{error}</p>}
              <div className="flex justify-end mt-3">
                <button
                  type="submit"
                  className="btn-primary px-4"
                  disabled={submitting || !commentBody.trim()}
                >
                  {submitting ? "Posting…" : "Comment"}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Sidebar */}
        <aside className="w-56 flex-shrink-0 hidden lg:block">
          <div className="text-sm">
            <p className="font-semibold text-gh-text mb-2 pb-2 border-b border-gh-border">Labels</p>
            {issue.labels.length === 0 ? (
              <p className="text-gh-muted text-xs">None yet</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {issue.labels.map((lbl) => (
                  <span
                    key={lbl.id}
                    className="inline-flex items-center px-2 py-0.5 text-xs rounded-full font-medium"
                    style={{ backgroundColor: `#${lbl.color}22`, color: `#${lbl.color}`, border: `1px solid #${lbl.color}44` }}
                  >
                    {lbl.name}
                  </span>
                ))}
              </div>
            )}

            {issue.assignee && (
              <>
                <p className="font-semibold text-gh-text mb-2 pb-2 border-b border-gh-border mt-4">Assignee</p>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-gray-400 flex items-center justify-center text-white text-xs font-bold">
                    {issue.assignee[0]?.toUpperCase()}
                  </div>
                  <span className="text-sm">{issue.assignee}</span>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── New Issue Modal ──────────────────────────────────────────────────────────

function NewIssueModal({ token, handle, repoName, onCreated, onClose }: {
  token: string; handle: string; repoName: string;
  onCreated: (issue: Issue) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const issue = await createIssue(token, handle, repoName, title.trim(), body.trim() || undefined);
      onCreated(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 px-4 pt-16">
      <div className="bg-gh-canvas border border-gh-border rounded-xl w-full max-w-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border">
          <h2 className="text-base font-semibold">New issue</h2>
          <button className="text-gh-muted hover:text-gh-text bg-transparent border-none cursor-pointer p-1 rounded" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-4">
          <div>
            <label className="label" htmlFor="issue-title">Title <span className="text-gh-danger">*</span></label>
            <input id="issue-title" className="input" placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
          </div>
          <div>
            <label className="label" htmlFor="issue-body">Description</label>
            <textarea id="issue-body" className="input resize-none font-mono" placeholder="Leave a comment (supports Markdown)" value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
          </div>
          {error && <p className="text-gh-danger text-sm bg-gh-danger-muted rounded-md px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-2 pt-2 border-t border-gh-border">
            <button type="button" className="btn-default" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary px-4" disabled={submitting || !title.trim()}>
              {submitting ? "Submitting…" : "Submit new issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Issues List ──────────────────────────────────────────────────────────────

function IssuesList({ token, handle, repoName, user }: Omit<Props, "splat">) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const [stateFilter, setStateFilter] = useState<"open" | "closed">("open");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listIssues(token, handle, repoName, stateFilter)
      .then((d) => setIssues(d.issues))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, stateFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          {(["open", "closed"] as const).map((s) => (
            <button
              key={s}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${stateFilter === s ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
              onClick={() => setStateFilter(s)}
            >
              {s === "open"
                ? <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" /><path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" /></svg>
                : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-purple-600"><path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" /><path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" /></svg>
              }
              {s === "open" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
        <button className="btn-primary px-3" onClick={() => setShowNew(true)}>New issue</button>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gh-border">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded-full mt-0.5" />
                <div className="flex-1 space-y-2"><div className="h-4 bg-gray-200 rounded w-2/3" /><div className="h-3 bg-gray-100 rounded w-1/3" /></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-gh-danger">{error}</div>
        ) : issues.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-lg font-semibold text-gh-text">{stateFilter === "open" ? "No open issues" : "No closed issues"}</p>
            {stateFilter === "open" && <p className="text-gh-muted text-sm mt-1">Open a new issue to start tracking work.</p>}
          </div>
        ) : (
          <div className="divide-y divide-gh-border">
            {issues.map((issue) => (
              <button
                key={issue.id}
                className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-gh-bg transition-colors"
                onClick={() => navigate(`${base}/issues/${issue.number}`)}
              >
                {issue.state === "open" ? <OpenIcon /> : <ClosedIcon />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gh-text">
                    {issue.title}
                    {issue.labels.map((lbl) => (
                      <span key={lbl.id} className="ml-1.5 inline-flex items-center px-1.5 py-0.5 text-xs rounded-full font-medium" style={{ backgroundColor: `#${lbl.color}22`, color: `#${lbl.color}`, border: `1px solid #${lbl.color}44` }}>
                        {lbl.name}
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-gh-muted mt-0.5">
                    #{issue.number} {stateFilter === "open" ? "opened" : "closed"} {timeAgo(issue.createdAt)} by {issue.author}
                    {issue.assignee && ` · assigned to ${issue.assignee}`}
                  </p>
                </div>
                {issue.commentCount > 0 && (
                  <div className="flex items-center gap-1 text-xs text-gh-muted flex-shrink-0 mt-0.5">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z" /></svg>
                    {issue.commentCount}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewIssueModal token={token} handle={handle} repoName={repoName}
          onCreated={(issue) => { setShowNew(false); setIssues((p) => [issue, ...p]); }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function RepoIssuesTab({ token, handle, repoName, user, splat }: Props) {
  const match = splat.match(/^issues\/(\d+)$/);
  if (match) {
    return <IssueDetail token={token} handle={handle} repoName={repoName} user={user} number={Number(match[1])} />;
  }
  return <IssuesList token={token} handle={handle} repoName={repoName} user={user} />;
}
