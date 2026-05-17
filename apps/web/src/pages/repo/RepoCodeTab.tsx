import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCommits, listTree } from "../../api";
import { BlobViewer } from "../../components/BlobViewer";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { BranchInfo, CommitInfo, Repo, TreeEntry } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  repo: Repo;
  branches: BranchInfo[];
  defaultBranch: string;
  currentRef: string;
  onRefChange: (ref: string) => void;
  splat: string;
};

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0" style={{ color: "#54aeff" }}>
      <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
      <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" />
    </svg>
  );
}

function BranchSelector({ branches, currentRef, onRefChange }: {
  branches: BranchInfo[];
  currentRef: string;
  onRefChange: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="btn-default flex items-center gap-2 min-w-[160px] justify-between text-sm"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1.5 truncate">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted">
            <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
          </svg>
          <span className="truncate font-medium">{currentRef}</span>
        </span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
          <path fillRule="evenodd" d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-[calc(100%+4px)] w-72 bg-gh-canvas border border-gh-border rounded-lg shadow-xl z-20 overflow-hidden">
            <div className="px-3 py-2 border-b border-gh-border bg-gh-bg">
              <p className="text-xs font-semibold text-gh-muted uppercase tracking-wide">Switch branches</p>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {branches.map((b) => (
                <button
                  key={b.name}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gh-accent hover:text-white transition-colors"
                  style={{ color: b.name === currentRef ? "#0969da" : "#1f2328" }}
                  onClick={() => { onRefChange(b.name); setOpen(false); }}
                >
                  {b.name === currentRef ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
                      <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  ) : (
                    <span className="w-3 flex-shrink-0" />
                  )}
                  <span className="truncate">{b.name}</span>
                  {b.isDefault && (
                    <span className="ml-auto text-xs text-gh-muted border border-gh-border rounded px-1">default</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function RepoCodeTab({ token, handle, repoName, repo, branches, defaultBranch, currentRef, onRefChange, splat }: Props) {
  const base = `/${handle}/${repoName}`;

  // Detect blob mode
  const blobMatch = splat.match(/^blob\/([^/]+)\/(.+)$/);
  if (blobMatch) {
    const [, blobRef, blobPath] = blobMatch;
    return (
      <BlobViewer
        token={token}
        handle={handle}
        repoName={repoName}
        ref={blobRef}
        path={blobPath}
        repoBase={base}
      />
    );
  }

  return (
    <TreeView
      token={token}
      handle={handle}
      repoName={repoName}
      repo={repo}
      branches={branches}
      defaultBranch={defaultBranch}
      currentRef={currentRef}
      onRefChange={onRefChange}
      splat={splat}
      base={base}
    />
  );
}

function TreeView({ token, handle, repoName, branches, currentRef, onRefChange, splat, base }: Props & { base: string }) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [readme, setReadme] = useState<{ path: string; content: string } | null>(null);
  const [latestCommit, setLatestCommit] = useState<CommitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Extract current path from splat: "tree/main/src" → "src"
  const currentPath = (() => {
    const m = splat.match(/^tree\/[^/]+\/(.*)$/);
    return m ? m[1] : "";
  })();

  useEffect(() => {
    if (!currentRef) return;
    setLoading(true);
    setError(null);

    Promise.all([
      listTree(token, handle, repoName, currentRef, currentPath || undefined),
      listCommits(token, handle, repoName, currentRef, currentPath || undefined, 1),
    ])
      .then(([treeData, commitData]) => {
        const sorted = [...treeData.entries].sort((a, b) => {
          if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
        setReadme(treeData.readme);
        setLatestCommit(commitData.commits[0] ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, currentRef, currentPath]);

  const pathParts = currentPath ? currentPath.split("/") : [];

  function entryLink(entry: TreeEntry) {
    return entry.type === "tree"
      ? `${base}/tree/${currentRef}/${entry.path}`
      : `${base}/blob/${currentRef}/${entry.path}`;
  }

  const repoName_ = repoName;

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <BranchSelector branches={branches} currentRef={currentRef} onRefChange={onRefChange} />

        {/* Breadcrumb */}
        {pathParts.length > 0 && (
          <div className="flex items-center gap-1 text-sm text-gh-muted">
            <Link to={base} className="text-gh-accent hover:underline font-medium">{repoName_}</Link>
            {pathParts.map((part, i) => {
              const partPath = pathParts.slice(0, i + 1).join("/");
              return (
                <span key={i} className="flex items-center gap-1">
                  <span>/</span>
                  {i === pathParts.length - 1 ? (
                    <span className="font-semibold text-gh-text">{part}</span>
                  ) : (
                    <Link to={`${base}/tree/${currentRef}/${partPath}`} className="text-gh-accent hover:underline">
                      {part}
                    </Link>
                  )}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex-1" />

        <Link to={`${base}/commits`} className="btn-default text-sm no-underline flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" />
          </svg>
          Commits
        </Link>
      </div>

      {/* File tree */}
      {loading ? (
        <div className="card">
          <div className="divide-y divide-gh-border">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded flex-shrink-0" />
                <div className="h-4 bg-gray-200 rounded" style={{ width: `${120 + i * 30}px` }} />
                <div className="flex-1" />
                <div className="h-3 bg-gray-100 rounded w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="card p-12 text-center">
          <p className="text-gh-danger font-medium">{error}</p>
          <p className="text-gh-muted text-sm mt-2">This repository may be empty. Push your first commit to get started.</p>
        </div>
      ) : entries.length === 0 && pathParts.length === 0 ? (
        <div className="card p-16 text-center">
          <p className="text-xl font-semibold text-gh-text">This repository is empty</p>
          <p className="text-gh-muted text-sm mt-2">Push your first commit to get started.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          {/* Latest commit bar */}
          {latestCommit && (
            <div className="flex items-center gap-3 px-4 py-2 bg-gh-bg border-b border-gh-border text-sm">
              <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {latestCommit.authorName[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text truncate" style={{ maxWidth: 160 }}>{latestCommit.authorName}</span>
              <span className="text-gh-muted truncate flex-1 text-xs">{latestCommit.subject}</span>
              <code className="font-mono text-xs text-gh-muted bg-gh-canvas border border-gh-border px-1.5 py-0.5 rounded flex-shrink-0 hidden sm:block">
                {latestCommit.shortSha}
              </code>
              <span className="text-xs text-gh-muted flex-shrink-0 hidden md:block">
                {new Date(latestCommit.date).toLocaleDateString()}
              </span>
            </div>
          )}

          {/* Parent dir link */}
          {pathParts.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border hover:bg-gh-bg">
              <span className="w-4 h-4" />
              <Link
                to={pathParts.length === 1 ? base : `${base}/tree/${currentRef}/${pathParts.slice(0, -1).join("/")}`}
                className="text-sm text-gh-text hover:text-gh-accent"
              >
                ..
              </Link>
            </div>
          )}

          <div className="divide-y divide-gh-border">
            {entries.map((entry) => (
              <div key={entry.path} className="flex items-center gap-3 px-4 py-2 hover:bg-gh-bg group">
                {entry.type === "tree" ? <FolderIcon /> : <FileIcon />}
                <Link
                  to={entryLink(entry)}
                  className="text-sm text-gh-text hover:text-gh-accent flex-1 min-w-0 truncate group-hover:underline"
                >
                  {entry.name}
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* README */}
      {readme && !error && (
        <div className="card mt-4 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-gh-bg border-b border-gh-border">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted">
              <path fillRule="evenodd" d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.062 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75V1.75zm7.quincy 1.5v8.5a3.75 3.75 0 013.75-3.75h3.757V2.5h-3.5a2.25 2.25 0 00-2.25 2.25v.5h-1.5v-.5A2.25 2.25 0 006.003 2.5H2.5v9h2.758a3.75 3.75 0 013.742 3.5V3.25z" />
            </svg>
            <span className="text-sm font-semibold text-gh-text">{readme.path}</span>
          </div>
          <div className="px-8 py-6">
            <MarkdownRenderer content={readme.content} />
          </div>
        </div>
      )}
    </div>
  );
}
