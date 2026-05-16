import { useEffect, useState } from "react";
import { listIssues, createIssue } from "../../api";
import type { Issue, User } from "../../types";

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

function IssueStateIcon({ state }: { state: "open" | "closed" }) {
  if (state === "open") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success flex-shrink-0">
        <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-purple-600 flex-shrink-0">
      <path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" />
      <path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
    </svg>
  );
}

function NewIssueModal({ token, handle, repoName, onCreated, onClose }: {
  token: string;
  handle: string;
  repoName: string;
  onCreated: (issue: Issue) => void;
  onClose: () => void;
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
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 px-4 pt-16">
      <div
        className="bg-gh-canvas border border-gh-border rounded-xl w-full max-w-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border">
          <h2 className="text-gh-lg font-semibold">New issue</h2>
          <button
            className="text-gh-muted hover:text-gh-text bg-transparent border-none cursor-pointer p-1 rounded-md"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-4">
          <div className="form-group">
            <label className="label" htmlFor="issue-title">Title <span className="text-gh-danger">*</span></label>
            <input
              id="issue-title"
              className="input"
              placeholder="Issue title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label className="label" htmlFor="issue-body">Description</label>
            <textarea
              id="issue-body"
              className="input resize-none font-mono"
              placeholder="Leave a comment"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
            />
          </div>
          {error && (
            <p className="text-gh-danger text-gh-sm bg-gh-danger-muted rounded-md px-3 py-2">{error}</p>
          )}
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

export function RepoIssuesTab({ token, handle, repoName, user }: Props) {
  const [state, setState] = useState<"open" | "closed">("open");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  function load(s: "open" | "closed") {
    setLoading(true);
    setError(null);
    listIssues(token, handle, repoName, s)
      .then((d) => setIssues(d.issues))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(state); }, [token, handle, repoName, state]);

  function handleCreated(issue: Issue) {
    setShowNew(false);
    setIssues((prev) => [issue, ...prev]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            className={`text-gh-sm px-3 py-1 rounded-md ${state === "open" ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
            onClick={() => setState("open")}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="inline mr-1 text-gh-success">
              <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
              <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
            </svg>
            Open
          </button>
          <button
            className={`text-gh-sm px-3 py-1 rounded-md ${state === "closed" ? "font-semibold text-gh-text bg-gh-bg border border-gh-border" : "text-gh-muted hover:text-gh-text"}`}
            onClick={() => setState("closed")}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="inline mr-1 text-purple-600">
              <path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" />
              <path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
            </svg>
            Closed
          </button>
        </div>
        <button className="btn-primary px-3 py-1.5" onClick={() => setShowNew(true)}>
          New issue
        </button>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gh-border">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded-full mt-0.5" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-2/3" />
                  <div className="h-3 bg-gray-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-gh-danger">{error}</div>
        ) : issues.length === 0 ? (
          <div className="p-16 text-center">
            <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" className="mx-auto text-gh-muted mb-3">
              <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
              <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
            </svg>
            <p className="text-gh-lg font-semibold text-gh-text">
              {state === "open" ? "No open issues" : "No closed issues"}
            </p>
            {state === "open" && (
              <p className="text-gh-muted text-gh-sm mt-1">Open a new issue to start tracking.</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gh-border">
            {issues.map((issue) => (
              <div key={issue.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gh-bg">
                <IssueStateIcon state={issue.state} />
                <div className="flex-1 min-w-0">
                  <p className="text-gh-sm font-semibold text-gh-text">
                    {issue.title}
                    {issue.labels.map((lbl) => (
                      <span
                        key={lbl.id}
                        className="ml-1.5 inline-flex items-center px-1.5 py-0.5 text-gh-xs rounded-full font-medium"
                        style={{ backgroundColor: `#${lbl.color}22`, color: `#${lbl.color}`, border: `1px solid #${lbl.color}44` }}
                      >
                        {lbl.name}
                      </span>
                    ))}
                  </p>
                  <p className="text-gh-xs text-gh-muted mt-0.5">
                    #{issue.number} opened {timeAgo(issue.createdAt)} by {issue.author}
                    {issue.assignee && ` · assigned to ${issue.assignee}`}
                  </p>
                </div>
                {issue.commentCount > 0 && (
                  <div className="flex items-center gap-1 text-gh-xs text-gh-muted flex-shrink-0">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path fillRule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z" />
                    </svg>
                    {issue.commentCount}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewIssueModal
          token={token}
          handle={handle}
          repoName={repoName}
          onCreated={handleCreated}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}
