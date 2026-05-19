import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { closePull, createPull, getPRFileDiff, getPull, listPRCommits, listPRFiles, listPulls, mergePull } from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { BranchInfo, CommitInfo, FileDiff, PRFileEntry, PullRequest, User } from "../../types";
import { resolveFileDiffViewer } from "../../views/fileDiffViewerRegistry";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  branches: BranchInfo[];
  defaultBranch: string;
  currentRef: string;
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

// ─── PR File Row (lazy diff) ──────────────────────────────────────────────────

function PRFileRow({ token, handle, repoName, prNumber, file, base, headRef }: {
  token: string; handle: string; repoName: string; prNumber: number;
  file: PRFileEntry; base: string; headRef: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const filename = file.path.split("/").pop() ?? file.path;
  const Viewer = resolveFileDiffViewer(filename);

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

  const displayPath = file.status === "renamed" && file.oldPath
    ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <div className="border-b border-gh-border last:border-0">
      <div
        className="flex items-center gap-2 px-4 py-2 cursor-pointer select-none hover:bg-gh-bg"
        onClick={toggle}
      >
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="currentColor"
          className="text-gh-muted flex-shrink-0 transition-transform"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <path fillRule="evenodd" d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
        </svg>
        <Link
          to={`${base}/blob/${headRef}/${file.path}`}
          className="font-mono text-sm text-gh-accent hover:underline flex-1 min-w-0 truncate no-underline"
          onClick={(e) => e.stopPropagation()}
        >
          {displayPath}
        </Link>
        <div className="flex items-center gap-2 flex-shrink-0 text-xs font-mono">
          {!file.binary && file.additions > 0 && <span className="text-green-600">+{file.additions}</span>}
          {!file.binary && file.deletions > 0 && <span className="text-red-600">-{file.deletions}</span>}
          {file.binary && <span className="text-gh-muted text-xs">binary</span>}
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
      {expanded && (
        diffLoading ? (
          <div className="px-4 py-4 space-y-1 animate-pulse">
            {[...Array(5)].map((_, i) => <div key={i} className="h-3 bg-gray-100 rounded" style={{ width: `${50 + i * 10}%` }} />)}
          </div>
        ) : diff ? (
          <Viewer file={diff} repoBase={base} headRef={headRef} />
        ) : (
          <p className="px-4 py-3 text-sm text-gh-muted italic">No diff available</p>
        )
      )}
    </div>
  );
}

// ─── PR Detail ────────────────────────────────────────────────────────────────

function PullDetail({ token, handle, repoName, user, number }: {
  token: string; handle: string; repoName: string; user: User; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [pr, setPr] = useState<PullRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"commits" | "files">("commits");

  // Commits tab — loaded lazily on first visit
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);

  // Files tab — loaded lazily on first visit
  const [prFiles, setPrFiles] = useState<PRFileEntry[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPull(token, handle, repoName, number)
      .then(setPr)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  // Load commits when Commits tab first shown
  useEffect(() => {
    if (activeTab !== "commits" || commits !== null || !pr) return;
    setCommitsLoading(true);
    listPRCommits(token, handle, repoName, number)
      .then((d) => setCommits(d.commits))
      .catch(() => setCommits([]))
      .finally(() => setCommitsLoading(false));
  }, [activeTab, commits, pr, token, handle, repoName, number]);

  // Load file list when Files tab first shown
  useEffect(() => {
    if (activeTab !== "files" || prFiles !== null || !pr) return;
    setFilesLoading(true);
    listPRFiles(token, handle, repoName, number)
      .then((d) => setPrFiles(d.files))
      .catch(() => setPrFiles([]))
      .finally(() => setFilesLoading(false));
  }, [activeTab, prFiles, pr, token, handle, repoName, number]);

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

          {/* Tab bar */}
          <div className="tab-nav">
            <button className={activeTab === "commits" ? "tab-item-active" : "tab-item"} onClick={() => setActiveTab("commits")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" /></svg>
              Commits
              {commits !== null && <span className="counter">{commits.length}</span>}
            </button>
            <button className={activeTab === "files" ? "tab-item-active" : "tab-item"} onClick={() => setActiveTab("files")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" /></svg>
              Files changed
              {prFiles !== null && <span className="counter">{prFiles.length}</span>}
            </button>
          </div>

          {/* Commits tab */}
          {activeTab === "commits" && (
            commitsLoading ? (
              <div className="card divide-y divide-gh-border overflow-hidden animate-pulse">
                {[...Array(3)].map((_, i) => <div key={i} className="flex items-center gap-3 px-4 py-3"><div className="w-5 h-5 bg-gray-200 rounded-full" /><div className="flex-1 h-4 bg-gray-100 rounded" /><div className="w-16 h-5 bg-gray-100 rounded" /></div>)}
              </div>
            ) : commits !== null && commits.length === 0 ? (
              <div className="card p-8 text-center text-sm text-gh-muted">No commits found between branches.</div>
            ) : commits !== null ? (
              <div className="card divide-y divide-gh-border overflow-hidden">
                {commits.map((c) => (
                  <div key={c.sha} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gh-bg text-sm">
                    <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {c.authorName[0]?.toUpperCase()}
                    </div>
                    <span className="flex-1 min-w-0 truncate text-gh-text">{c.subject}</span>
                    <button
                      className="font-mono text-xs text-gh-muted bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded flex-shrink-0 hover:border-gh-accent hover:text-gh-accent transition-colors"
                      onClick={() => navigate(`${base}/commits/${c.sha}`)}
                    >
                      {c.shortSha}
                    </button>
                  </div>
                ))}
              </div>
            ) : null
          )}

          {/* Files changed tab */}
          {activeTab === "files" && (
            filesLoading ? (
              <div className="card animate-pulse divide-y divide-gh-border overflow-hidden">
                {[...Array(4)].map((_, i) => <div key={i} className="flex items-center gap-3 px-4 py-2.5"><div className="w-3 h-3 bg-gray-200 rounded" /><div className="h-4 bg-gray-100 rounded flex-1" /><div className="w-12 h-4 bg-gray-100 rounded" /></div>)}
              </div>
            ) : prFiles !== null && prFiles.length === 0 ? (
              <div className="card p-8 text-center text-sm text-gh-muted">No files changed.</div>
            ) : prFiles !== null ? (
              <div>
                <p className="text-sm text-gh-muted mb-2">
                  Showing <span className="font-semibold text-gh-text">{prFiles.length}</span> changed file{prFiles.length !== 1 ? "s" : ""} with{" "}
                  <span className="text-green-600 font-mono font-semibold">+{prFiles.reduce((s, f) => s + f.additions, 0)}</span>{" "}
                  <span className="text-red-600 font-mono font-semibold">-{prFiles.reduce((s, f) => s + f.deletions, 0)}</span>
                </p>
                <div className="card overflow-hidden">
                  {prFiles.map((file) => (
                    <PRFileRow key={file.path} token={token} handle={handle} repoName={repoName} prNumber={number} file={file} base={base} headRef={pr.fromBranch} />
                  ))}
                </div>
              </div>
            ) : null
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

// ─── PR Create ───────────────────────────────────────────────────────────────

function PullCreate({ token, handle, repoName, branches, defaultBranch, currentRef }: Omit<Props, "splat" | "user">) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const initialFrom = currentRef !== defaultBranch ? currentRef : (branches.find((b) => !b.isDefault)?.name ?? currentRef);
  const [fromBranch, setFromBranch] = useState(initialFrom);
  const [toBranch, setToBranch] = useState(defaultBranch);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameBranch = fromBranch === toBranch;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || sameBranch) return;
    setSubmitting(true);
    setError(null);
    try {
      const pr = await createPull(token, handle, repoName, title.trim(), fromBranch, toBranch, description.trim() || undefined);
      navigate(`${base}/pulls/${pr.number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pull request");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <Link to={`${base}/pulls`} className="inline-flex items-center gap-1.5 text-sm text-gh-muted hover:text-gh-accent mb-4 no-underline">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z" /></svg>
        Pull requests
      </Link>

      <h1 className="text-2xl font-semibold text-gh-text mb-6">New pull request</h1>

      {/* Branch selectors */}
      <div className="card p-4 mb-6">
        <p className="text-sm text-gh-muted mb-3">Choose the branch you want to merge into and the branch with your changes.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gh-text">base:</span>
            <select
              value={toBranch}
              onChange={(e) => setToBranch(e.target.value)}
              className="input text-sm py-1.5"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>
              ))}
            </select>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
            <path fillRule="evenodd" d="M8.22 2.97a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06l2.97-2.97H3.75a.75.75 0 010-1.5h7.44L8.22 4.03a.75.75 0 010-1.06z" />
          </svg>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gh-text">compare:</span>
            <select
              value={fromBranch}
              onChange={(e) => setFromBranch(e.target.value)}
              className="input text-sm py-1.5"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>
        {sameBranch && (
          <p className="mt-3 text-sm text-gh-danger">Base and compare branches must be different.</p>
        )}
      </div>

      {/* Form */}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gh-text mb-1">Title</label>
          <input
            type="text"
            className="input w-full"
            placeholder="Pull request title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gh-text mb-1">Description <span className="text-gh-muted font-normal">(optional)</span></label>
          <textarea
            className="input w-full font-sans resize-y"
            rows={6}
            placeholder="Describe your changes…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-gh-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="btn-primary px-4"
            disabled={submitting || !title.trim() || sameBranch}
          >
            {submitting ? "Creating…" : "Create pull request"}
          </button>
          <Link to={`${base}/pulls`} className="btn-default no-underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

// ─── PR List ─────────────────────────────────────────────────────────────────

function PullsList({ token, handle, repoName, user }: Omit<Props, "splat" | "branches" | "defaultBranch" | "currentRef">) {
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
        <Link to={`${base}/pulls/new`} className="btn-primary text-sm no-underline ml-auto">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="inline mr-1.5 -mt-0.5">
            <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          New pull request
        </Link>
      </div>
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

export function RepoPullsTab({ token, handle, repoName, user, branches, defaultBranch, currentRef, splat }: Props) {
  const match = splat.match(/^pulls\/(\d+)$/);
  if (match) {
    return <PullDetail token={token} handle={handle} repoName={repoName} user={user} number={Number(match[1])} />;
  }
  if (splat === "pulls/new") {
    return <PullCreate token={token} handle={handle} repoName={repoName} branches={branches} defaultBranch={defaultBranch} currentRef={currentRef} />;
  }
  return <PullsList token={token} handle={handle} repoName={repoName} user={user} />;
}
