import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { API_BASE, listCommits, listTree } from "../../api";
import { BlobViewer } from "../../components/BlobViewer";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import {
  Badge,
  Button,
  Dialog,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  Field,
  Icons,
  RelativeTime,
  Select,
  Skeleton,
  TextInput,
  useToast,
} from "../../ui";
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
  onCreateBranch: (name: string, from: string) => Promise<void>;
  splat: string;
};

// ── local icons (Octicon-style, currentColor) ────────────────────────────────
function CodeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-fh-accent-fg shrink-0" aria-hidden="true">
      <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-fh-fg-muted shrink-0" aria-hidden="true">
      <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" />
    </svg>
  );
}

function CommitGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-fh-fg-muted shrink-0" aria-hidden="true">
      <path fillRule="evenodd" d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.062 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75V1.75zm7.75 3.19v8.502A3.75 3.75 0 0111.006 11.5h3.744V2.5h-3.5a2.25 2.25 0 00-2.25 2.25v.19zm-1.5 8.502V4.75A2.25 2.25 0 004.75 2.5H1.25v9h4.008a3.75 3.75 0 01.992.132V13.442z" />
    </svg>
  );
}

// ── clone dropdown ────────────────────────────────────────────────────────────
function CloneDropdown({ handle, repoName, visibility }: { handle: string; repoName: string; visibility: string }) {
  const { toast } = useToast();
  const url = `${API_BASE}/git/${handle}/${repoName}.git`;

  function copy() {
    void navigator.clipboard.writeText(url).then(() => toast("Clone URL copied", { tone: "success" }));
  }

  return (
    <DropdownMenu
      align="end"
      width={360}
      trigger={
        <Button variant="primary" size="sm" leadingIcon={<CodeGlyph />} trailingIcon={<Icons.ChevronDownIcon size={12} />}>
          Code
        </Button>
      }
    >
      <DropdownLabel>Clone with HTTPS</DropdownLabel>
      <div className="px-3 pb-2 pt-1">
        <div className="flex items-center gap-1.5">
          <span className="flex-1 min-w-0 truncate font-mono text-fh-xs text-fh-fg-muted bg-fh-surface-inset border border-fh-border rounded-md px-2 py-1.5">
            {url}
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy clone URL"
            title="Copy clone URL"
            className="shrink-0 inline-flex items-center justify-center h-[30px] w-8 rounded-md border border-fh-border bg-fh-surface text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg cursor-pointer"
          >
            <CopyGlyph />
          </button>
        </div>
        <p className="mt-2 text-fh-xs text-fh-fg-subtle">
          Clone with <code className="font-mono text-fh-fg-muted">git clone {"<url>"}</code>.
          {visibility === "private" && " You'll be prompted for your ForgeHub username and password."}
        </p>
      </div>
    </DropdownMenu>
  );
}

function CopyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
      <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
    </svg>
  );
}

// ── branch switcher ─────────────────────────────────────────────────────────
function BranchSwitcher({ branches, currentRef, onRefChange, onCreateBranch }: {
  branches: BranchInfo[];
  currentRef: string;
  onRefChange: (ref: string) => void;
  onCreateBranch: (name: string, from: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [fromRef, setFromRef] = useState(currentRef);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && /^[\w/._-]+$/.test(trimmed) && !branches.some((b) => b.name === trimmed);

  function openDialog() {
    setName("");
    setFromRef(currentRef);
    setError(null);
    setDialogOpen(true);
  }

  async function handleCreate() {
    if (!valid || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreateBranch(trimmed, fromRef);
      toast(`Branch ${trimmed} created`, { tone: "success" });
      setDialogOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create branch");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <DropdownMenu
        align="start"
        width={280}
        trigger={
          <Button
            variant="default"
            size="sm"
            leadingIcon={<BranchGlyph />}
            trailingIcon={<Icons.ChevronDownIcon size={12} />}
            className="max-w-[220px]"
          >
            <span className="truncate">{currentRef}</span>
          </Button>
        }
      >
        <DropdownLabel>Switch branches</DropdownLabel>
        {branches.map((b) => (
          <DropdownItem
            key={b.name}
            leadingIcon={b.name === currentRef ? <Icons.CheckIcon size={14} /> : <span className="w-3.5 inline-block" />}
            trailing={b.isDefault ? <Badge tone="neutral" pill={false} className="text-fh-xs">default</Badge> : undefined}
            onSelect={() => onRefChange(b.name)}
          >
            <span className={b.name === currentRef ? "font-semibold" : undefined}>{b.name}</span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem leadingIcon={<BranchGlyph />} onSelect={openDialog}>
          New branch…
        </DropdownItem>
      </DropdownMenu>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Create a branch"
        size="sm"
        footer={
          <>
            <Button variant="default" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={creating} disabled={!valid} onClick={handleCreate}>Create branch</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Branch name" required hint="Letters, numbers, and / . _ - only." error={error ?? undefined}>
            {(id) => (
              <TextInput
                id={id}
                value={name}
                autoFocus
                placeholder="feature/my-change"
                invalid={!!error}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              />
            )}
          </Field>
          <Field label="Branch source">
            {(id) => (
              <Select id={id} value={fromRef} onChange={(e) => setFromRef(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
    </>
  );
}

export function RepoCodeTab({ token, handle, repoName, repo, branches, defaultBranch, currentRef, onRefChange, onCreateBranch, splat }: Props) {
  const base = `/${handle}/${repoName}`;

  // Detect blob mode — use currentRef state to correctly split ref/path even for slashed branch names
  if (splat.startsWith("blob/")) {
    const blobPrefix = `blob/${currentRef}/`;
    let blobRef: string, blobPath: string;
    if (currentRef && splat.startsWith(blobPrefix)) {
      blobRef = currentRef;
      blobPath = splat.slice(blobPrefix.length);
    } else {
      const m = splat.match(/^blob\/([^/]+)\/(.+)$/);
      if (!m) return null;
      [, blobRef, blobPath] = m;
    }
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
      onCreateBranch={onCreateBranch}
      splat={splat}
      base={base}
    />
  );
}

function TreeView({ token, handle, repoName, repo, branches, currentRef, onRefChange, onCreateBranch, splat, base }: Props & { base: string }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [readme, setReadme] = useState<{ path: string; content: string } | null>(null);
  const [latestCommit, setLatestCommit] = useState<CommitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Extract current path — use currentRef state as prefix so slashed branch names work correctly.
  const currentPath = (() => {
    const treePrefix = `tree/${currentRef}`;
    if (splat === treePrefix) return "";
    if (splat.startsWith(treePrefix + "/")) return splat.slice(treePrefix.length + 1);
    return "";
  })();

  useEffect(() => {
    if (!currentRef) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    // NOTE: the commits endpoint only filters by branch (path is ignored server-side),
    // so we surface the branch-HEAD commit once in the header bar rather than fabricate a
    // per-file "last commit" column that would repeat the same commit on every row.
    Promise.all([
      listTree(token, handle, repoName, currentRef, currentPath || undefined),
      listCommits(token, handle, repoName, currentRef, currentPath || undefined, 1),
    ])
      .then(([treeData, commitData]) => {
        if (cancelled) return;
        const sorted = [...treeData.entries].sort((a, b) => {
          if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
        setReadme(treeData.readme);
        setLatestCommit(commitData.commits[0] ?? null);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [token, handle, repoName, currentRef, currentPath]);

  const pathParts = currentPath ? currentPath.split("/") : [];

  function entryLink(entry: TreeEntry) {
    return entry.type === "tree"
      ? `${base}/tree/${currentRef}/${entry.path}`
      : `${base}/blob/${currentRef}/${entry.path}`;
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <BranchSwitcher branches={branches} currentRef={currentRef} onRefChange={onRefChange} onCreateBranch={onCreateBranch} />

        {/* Breadcrumb path navigation */}
        {pathParts.length > 0 && (
          <nav aria-label="Path" className="flex items-center gap-1.5 text-fh-base min-w-0">
            <Link to={base} className="text-fh-accent-fg hover:underline font-semibold">{repoName}</Link>
            {pathParts.map((part, i) => {
              const partPath = pathParts.slice(0, i + 1).join("/");
              const last = i === pathParts.length - 1;
              return (
                <span key={i} className="flex items-center gap-1.5 min-w-0">
                  <span className="text-fh-fg-subtle select-none">/</span>
                  {last ? (
                    <span className="font-semibold text-fh-fg truncate">{part}</span>
                  ) : (
                    <Link to={`${base}/tree/${currentRef}/${partPath}`} className="text-fh-accent-fg hover:underline truncate">
                      {part}
                    </Link>
                  )}
                </span>
              );
            })}
          </nav>
        )}

        <div className="flex-1" />

        <Button variant="default" size="sm" leadingIcon={<CommitGlyph />} onClick={() => navigate(`${base}/commits`)}>
          Commits
        </Button>
        <CloneDropdown handle={handle} repoName={repoName} visibility={repo.visibility} />
      </div>

      {/* File tree */}
      {loading ? (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          <div className="flex items-center gap-3 px-4 py-2.5 bg-fh-canvas border-b border-fh-border">
            <Skeleton variant="circle" className="w-5 h-5" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40 hidden sm:block" />
          </div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-fh-border-muted last:border-b-0">
              <Skeleton className="w-4 h-4" />
              <Skeleton className="h-3.5" width={110 + i * 24} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="border border-fh-border rounded-md bg-fh-surface p-12 text-center">
          <p className="text-fh-danger-fg font-medium">{error}</p>
          <p className="text-fh-fg-muted text-fh-base mt-2">This repository may be empty. Push your first commit to get started.</p>
        </div>
      ) : entries.length === 0 && pathParts.length === 0 ? (
        <div className="border border-fh-border rounded-md bg-fh-surface p-16 text-center">
          <p className="text-fh-xl font-semibold text-fh-fg">This repository is empty</p>
          <p className="text-fh-fg-muted text-fh-base mt-2">Push your first commit to get started.</p>
        </div>
      ) : (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          {/* Latest commit bar */}
          {latestCommit && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-fh-canvas border-b border-fh-border text-fh-sm">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-fh-accent-emphasis text-fh-on-emphasis text-fh-xs font-semibold shrink-0">
                {latestCommit.authorName[0]?.toUpperCase()}
              </span>
              <span className="font-semibold text-fh-fg truncate max-w-[160px]">{latestCommit.authorName}</span>
              <span className="text-fh-fg-muted truncate flex-1 min-w-0" title={latestCommit.subject}>{latestCommit.subject}</span>
              <code className="font-mono text-fh-xs text-fh-fg-muted bg-fh-surface border border-fh-border px-1.5 py-0.5 rounded shrink-0 hidden sm:block">
                {latestCommit.shortSha}
              </code>
              <RelativeTime date={latestCommit.date} className="text-fh-xs text-fh-fg-subtle shrink-0 hidden md:block" />
            </div>
          )}

          {/* Parent dir link */}
          {pathParts.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-fh-border-muted hover:bg-fh-surface-muted">
              <span className="w-4 shrink-0" />
              <Link
                to={pathParts.length === 1 ? base : `${base}/tree/${currentRef}/${pathParts.slice(0, -1).join("/")}`}
                className="text-fh-base text-fh-fg-muted hover:text-fh-accent-fg font-medium"
              >
                ..
              </Link>
            </div>
          )}

          {entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-3 px-4 py-2 border-b border-fh-border-muted last:border-b-0 hover:bg-fh-surface-muted"
            >
              {entry.type === "tree" ? <FolderIcon /> : <FileIcon />}
              <Link to={entryLink(entry)} className="text-fh-base text-fh-fg hover:text-fh-accent-fg hover:underline truncate">
                {entry.name}
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* README */}
      {readme && !error && (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface mt-4">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-fh-canvas border-b border-fh-border">
            <BookIcon />
            <span className="text-fh-base font-semibold text-fh-fg">{readme.path}</span>
          </div>
          <div className="px-6 py-6 md:px-8">
            <MarkdownRenderer content={readme.content} />
          </div>
        </div>
      )}
    </div>
  );
}
