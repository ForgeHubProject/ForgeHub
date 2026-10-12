import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { API_BASE, downloadArchive, getCheckSummary, getTreeCommits, listCommits, listRepoPaths, listTree, sshCloneUrl } from "../../api";
import { CheckStatusIcon, checkState } from "./ci/ciShared";
import type { CheckSummary } from "../../types";
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
import type { BranchInfo, CommitInfo, Repo, RepoSocial, TreeCommits, TreeEntry } from "../../types";
import { CompositionBar } from "./CompositionBar";
import { blobFromSplat, refLabel } from "./refs";
import { AboutSection, ContributorsSection, ReleasesSection } from "./RepoSidebar";
import { FileIcon, FolderIcon } from "./fileIcons";
import { useStoredFlag } from "../../lib/storedFlag";
import { FileTreePane } from "./FileTreePane";
import { GoToFile } from "./GoToFile";
import { SidebarToggle } from "./SidebarToggle";
import { HistoryGlyph, LatestCommitBar, historyUrl } from "./LatestCommitBar";

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
  /** Star/watch counts for the sidebar's About (RepoPage owns them). */
  social?: RepoSocial | null;
  /** Shows About's edit link — the same people who see the Settings tab. */
  canEditSettings?: boolean;
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

function CommitGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" />
    </svg>
  );
}

function CompareGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
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
function CloneDropdown({ token, handle, repoName, visibility, currentRef, sshPort, sshHost }: {
  token: string; handle: string; repoName: string; visibility: string; currentRef: string;
  sshPort?: number | null; sshHost?: string | null;
}) {
  const { toast } = useToast();
  const httpsUrl = `${API_BASE}/git/${handle}/${repoName}.git`;
  // SSH is offered only when the server config exposes a port (issue #116). The
  // host comes from the browser unless the server pins an explicit override.
  const sshEnabled = typeof sshPort === "number" && sshPort > 0;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const sshUrl = sshEnabled ? sshCloneUrl({ handle, repoName, sshPort, sshHost, hostname }) : "";
  const [protocol, setProtocol] = useState<"https" | "ssh">("https");
  const [downloading, setDownloading] = useState(false);

  const url = protocol === "ssh" && sshEnabled ? sshUrl : httpsUrl;

  function copy() {
    void navigator.clipboard.writeText(url).then(() => toast("Clone URL copied", { tone: "success" }));
  }

  async function downloadZip() {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadArchive(token, handle, repoName, currentRef, "zip");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed", { tone: "danger" });
    } finally {
      setDownloading(false);
    }
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
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <DropdownLabel>Clone with {protocol === "ssh" ? "SSH" : "HTTPS"}</DropdownLabel>
        {sshEnabled && (
          <div className="inline-flex rounded-md border border-fh-border overflow-hidden text-fh-xs" role="tablist" aria-label="Clone protocol">
            {(["https", "ssh"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={protocol === p}
                onClick={() => setProtocol(p)}
                className={
                  "px-2.5 py-1 font-medium cursor-pointer " +
                  (protocol === p ? "bg-fh-surface-muted text-fh-fg" : "bg-fh-surface text-fh-fg-muted hover:text-fh-fg")
                }
              >
                {p === "https" ? "HTTPS" : "SSH"}
              </button>
            ))}
          </div>
        )}
      </div>
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
          {protocol === "ssh" && sshEnabled ? (
            <>Clone with <code className="font-mono text-fh-fg-muted">git clone {"<url>"}</code> using an SSH key added in Settings → SSH keys.</>
          ) : (
            <>
              Clone with <code className="font-mono text-fh-fg-muted">git clone {"<url>"}</code>.
              {visibility === "private" && " You'll be prompted for your ForgeHub username and password."}
            </>
          )}
        </p>
        {!sshEnabled && (
          <p className="mt-1.5 text-fh-xs text-fh-fg-subtle">
            SSH is not enabled on this server.{" "}
            <span title="Set FORGEHUB_SSH_PORT in the server environment to enable git clone over SSH.">
              Set <code className="font-mono text-fh-fg-muted">FORGEHUB_SSH_PORT</code> to enable SSH cloning.
            </span>
          </p>
        )}
      </div>
      <DropdownSeparator />
      <DropdownItem leadingIcon={<DownloadGlyph />} onSelect={downloadZip}>
        {downloading ? "Preparing ZIP…" : `Download ZIP (${currentRef})`}
      </DropdownItem>
    </DropdownMenu>
  );
}

function DownloadGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.47 10.78a.75.75 0 001.06 0l3.75-3.75a.75.75 0 00-1.06-1.06L8.75 8.44V1.75a.75.75 0 00-1.5 0v6.69L4.78 5.97a.75.75 0 00-1.06 1.06l3.75 3.75zM3.75 13a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z" />
    </svg>
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
function BranchSwitcher({ branches, currentRef, onRefChange, onCreateBranch, base }: {
  branches: BranchInfo[];
  currentRef: string;
  onRefChange: (ref: string) => void;
  onCreateBranch: (name: string, from: string) => Promise<void>;
  base: string;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
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
        searchPlaceholder="Find a branch…"
        trigger={
          <Button
            variant="default"
            size="sm"
            leadingIcon={<BranchGlyph />}
            trailingIcon={<Icons.ChevronDownIcon size={12} />}
            className="max-w-[220px]"
          >
            <span className="truncate">{refLabel(currentRef)}</span>
          </Button>
        }
      >
        {(query) => {
          const q = query.trim().toLowerCase();
          const matches = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
          return (
            <>
              <DropdownLabel>Switch branches</DropdownLabel>
              {matches.length === 0 && (
                <p className="px-3 py-1.5 text-fh-sm text-fh-fg-muted">No matching branches</p>
              )}
              {matches.map((b) => (
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
              <DropdownItem leadingIcon={<span className="w-3.5 inline-block" />} onSelect={() => navigate(`${base}/branches`)}>
                View all branches
              </DropdownItem>
            </>
          );
        }}
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

/** Whether the file page's repository tree is shown, a per-browser preference. */
const FILE_PAGE_TREE_KEY = "fh.file.fileTree";

/**
 * The file page (#223), GitHub's anatomy: full width, the repository tree as a
 * left pane (with the branch picker and Go to file above it), the file filling
 * the rest. The pane hides, remembered per browser; its controls then sit
 * above the file. It stacks above the file on narrow screens.
 */
function FilePage({ token, handle, repoName, base, gitRef, path, branches, onCreateBranch }: {
  token: string;
  handle: string;
  repoName: string;
  base: string;
  gitRef: string;
  path: string;
  branches: BranchInfo[];
  onCreateBranch: (name: string, from: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [treeShown, setTreeShown] = useStoredFlag(FILE_PAGE_TREE_KEY, true);

  // Switching branch keeps the file when it exists there, and says so when not.
  async function switchRef(next: string) {
    if (next === gitRef) return;
    try {
      const { paths } = await listRepoPaths(token, handle, repoName, next);
      if (paths.includes(path)) return navigate(`${base}/blob/${next}/${path}`);
      toast(`${path} doesn't exist on ${next}`);
    } catch {
      /* fall through to the branch's root */
    }
    navigate(`${base}/tree/${next}`);
  }

  const picker = (
    <BranchSwitcher branches={branches} currentRef={gitRef} onRefChange={(r) => void switchRef(r)} onCreateBranch={onCreateBranch} base={base} />
  );
  const goTo = <GoToFile token={token} handle={handle} repoName={repoName} gitRef={gitRef} base={base} />;

  return (
    <div className="-mx-4 -mt-6 flex flex-col md:flex-row lg:-mx-8">
      {treeShown && (
        // The pane stretches to the row's height so its divider runs the whole
        // way down beside the file; only what's inside it is sticky, under the
        // pinned site header (h-14).
        <aside aria-label="Files" className="w-full shrink-0 border-b border-fh-border md:w-72 md:border-b-0 md:border-r">
          <div className="space-y-3 px-4 py-4 md:sticky md:top-14 md:max-h-[calc(100vh-3.5rem)] md:overflow-y-auto lg:pl-8">
            <div className="flex items-center gap-2">
              <SidebarToggle shown onToggle={setTreeShown} />
              <div className="min-w-0 flex-1">{picker}</div>
            </div>
            {goTo}
            <div className="max-h-[40vh] overflow-y-auto md:max-h-none md:overflow-visible">
              <FileTreePane token={token} handle={handle} repoName={repoName} gitRef={gitRef} currentPath={path} base={base} />
            </div>
          </div>
        </aside>
      )}
      <div className="min-w-0 flex-1 px-4 py-4 lg:pr-8">
        {!treeShown && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SidebarToggle shown={false} onToggle={setTreeShown} />
            {picker}
            <div className="w-full sm:w-72">{goTo}</div>
          </div>
        )}
        <BlobViewer
          token={token}
          handle={handle}
          repoName={repoName}
          ref={gitRef}
          path={path}
          repoBase={base}
          beforeFile={<LatestCommitBar token={token} handle={handle} repoName={repoName} gitRef={gitRef} path={path} base={base} />}
        />
      </div>
    </div>
  );
}

export function RepoCodeTab({ token, handle, repoName, repo, branches, defaultBranch, currentRef, onRefChange, onCreateBranch, splat, social, canEditSettings }: Props) {
  const base = `/${handle}/${repoName}`;

  // Detect blob mode — split ref/path against the branch list, not currentRef,
  // which still holds the default branch on the first render of a slashed one.
  if (splat.startsWith("blob/")) {
    const blob = blobFromSplat(splat, branches);
    if (!blob) return null;
    return (
      <FilePage
        token={token}
        handle={handle}
        repoName={repoName}
        base={base}
        gitRef={blob.ref}
        path={blob.path}
        branches={branches}
        onCreateBranch={onCreateBranch}
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
      social={social}
      canEditSettings={canEditSettings}
    />
  );
}

function TreeView({ token, handle, repoName, repo, branches, defaultBranch, currentRef, onRefChange, onCreateBranch, splat, base, social, canEditSettings }: Props & { base: string }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [readme, setReadme] = useState<{ path: string; content: string } | null>(null);
  const [latestCommit, setLatestCommit] = useState<CommitInfo | null>(null);
  const [headStatus, setHeadStatus] = useState<CheckSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Last commit per entry (#210): fetched on its own so the listing never waits
  // on it. null while loading; "failed" leaves the columns empty.
  const [entryCommits, setEntryCommits] = useState<TreeCommits | "failed" | null>(null);

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

    // The header bar shows the most recent commit touching the directory being
    // viewed (the commits endpoint filters by path server-side, issue #109); the
    // per-entry columns come from tree-commits, below.
    Promise.all([
      listTree(token, handle, repoName, currentRef, currentPath || undefined),
      listCommits(token, handle, repoName, currentRef, { path: currentPath || undefined, perPage: 1 }),
    ])
      .then(([treeData, commitData]) => {
        if (cancelled) return;
        const sorted = [...treeData.entries].sort((a, b) => {
          if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
        setReadme(treeData.readme);
        const head = commitData.commits[0] ?? null;
        setLatestCommit(head);
        // CI status for that commit (best-effort; 404 → no checks).
        setHeadStatus(null);
        if (head) {
          getCheckSummary(token, handle, repoName, head.sha)
            .then((s) => { if (!cancelled) setHeadStatus(s); })
            .catch(() => { if (!cancelled) setHeadStatus(null); });
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [token, handle, repoName, currentRef, currentPath]);

  useEffect(() => {
    if (!currentRef) return;
    let cancelled = false;
    setEntryCommits(null);
    getTreeCommits(token, handle, repoName, currentRef, currentPath || undefined)
      .then((d) => { if (!cancelled) setEntryCommits(d); })
      .catch(() => { if (!cancelled) setEntryCommits("failed"); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, currentRef, currentPath]);

  const pathParts = currentPath ? currentPath.split("/") : [];
  const lastCommits = entryCommits && entryCommits !== "failed" ? entryCommits : null;

  function entryLink(entry: TreeEntry) {
    return entry.type === "tree"
      ? `${base}/tree/${currentRef}/${entry.path}`
      : `${base}/blob/${currentRef}/${entry.path}`;
  }

  // At the repository root the page gets GitHub's sidebar (#208): About on the
  // right from lg up — and first, above the file list, on narrower screens,
  // since what a repository is matters before what is in it — then Formats,
  // Releases and Contributors under it (after the README on narrow screens).
  // A grid rather than two columns so the narrow order needs no duplicate About.
  const atRoot = currentPath === "";

  return (
    <div className={atRoot ? "grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1fr)_296px] lg:grid-rows-[auto_1fr]" : undefined}>
      {atRoot && (
        <aside aria-label="About this repository" className="lg:col-start-2 lg:row-start-1">
          <AboutSection
            repo={repo}
            social={social ?? null}
            base={base}
            defaultBranch={defaultBranch}
            hasReadme={!!readme && !error}
            canEditSettings={!!canEditSettings}
          />
        </aside>
      )}

      <div className={atRoot ? "min-w-0 lg:col-start-1 lg:row-start-1 lg:row-span-2" : undefined}>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <BranchSwitcher branches={branches} currentRef={currentRef} onRefChange={onRefChange} onCreateBranch={onCreateBranch} base={base} />

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
        <Button variant="default" size="sm" leadingIcon={<CompareGlyph />} onClick={() => navigate(`${base}/compare`)}>
          Compare
        </Button>
        <CloneDropdown token={token} handle={handle} repoName={repoName} visibility={repo.visibility} currentRef={currentRef} sshPort={repo.sshPort} sshHost={repo.sshHost} />
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
              <Link
                to={`${base}/commits/${latestCommit.sha}`}
                className="text-fh-fg-muted truncate flex-1 min-w-0 no-underline hover:text-fh-accent-fg hover:underline"
                title={latestCommit.subject}
              >
                {latestCommit.subject}
              </Link>
              {headStatus && (
                <Link to={`${base}/actions`} className="inline-flex items-center shrink-0 no-underline" title="View workflow runs" aria-label="Commit checks">
                  <CheckStatusIcon state={checkState(headStatus)} size={15} />
                </Link>
              )}
              <Link
                to={`${base}/commits/${latestCommit.sha}`}
                className="font-mono text-fh-xs text-fh-fg-muted bg-fh-surface border border-fh-border px-1.5 py-0.5 rounded shrink-0 hidden sm:block no-underline transition-colors hover:text-fh-accent-fg hover:border-fh-border-strong"
                title={`View commit ${latestCommit.sha}`}
              >
                {latestCommit.shortSha}
              </Link>
              <RelativeTime date={latestCommit.date} className="text-fh-xs text-fh-fg-subtle shrink-0 hidden md:block" />
              {currentPath !== "" && (
                <Link
                  to={historyUrl(base, currentRef, currentPath)}
                  className="inline-flex shrink-0 items-center gap-1 text-fh-xs font-semibold text-fh-fg no-underline hover:text-fh-accent-fg"
                  title={`Commits that changed ${currentPath}`}
                >
                  <HistoryGlyph />
                  History
                </Link>
              )}
              {currentPath === "" && lastCommits && lastCommits.totalCommits > 0 && (
                <Link
                  to={`${base}/commits`}
                  className="inline-flex shrink-0 items-center gap-1 text-fh-xs font-semibold text-fh-fg no-underline hover:text-fh-accent-fg"
                  title="View commit history"
                >
                  <HistoryGlyph />
                  {lastCommits.totalCommits.toLocaleString()} {lastCommits.totalCommits === 1 ? "commit" : "commits"}
                </Link>
              )}
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

          {entries.map((entry) => {
            const last = lastCommits?.commits[entry.name];
            return (
              <div
                key={entry.path}
                className="flex items-center gap-3 px-4 py-2 border-b border-fh-border-muted last:border-b-0 hover:bg-fh-surface-muted"
              >
                {entry.type === "tree" ? <FolderIcon /> : <FileIcon />}
                {/* Name, then — from sm up — the last commit's message and, from md
                    up, its date (#210): the same breakpoints as the commit bar. */}
                <div className="min-w-0 flex-1 sm:flex-none sm:w-1/3">
                  <Link to={entryLink(entry)} className="block text-fh-base text-fh-fg hover:text-fh-accent-fg hover:underline truncate">
                    {entry.name}
                  </Link>
                </div>
                <div className="hidden sm:block min-w-0 flex-1 text-fh-sm">
                  {last ? (
                    <Link
                      to={`${base}/commits/${last.sha}`}
                      title={last.subject}
                      className="block truncate text-fh-fg-muted no-underline hover:text-fh-accent-fg hover:underline"
                    >
                      {last.subject}
                    </Link>
                  ) : (
                    entryCommits === null && <Skeleton className="h-3" width={140} />
                  )}
                </div>
                <div className="hidden md:block w-28 shrink-0 text-right text-fh-xs text-fh-fg-subtle">
                  {last ? <RelativeTime date={last.date} /> : entryCommits === null && <Skeleton className="ml-auto h-3" width={56} />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* README */}
      {readme && !error && (
        <div id="readme" className="scroll-mt-16 border border-fh-border rounded-md overflow-hidden bg-fh-surface mt-4">
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

      {atRoot && currentRef && (
        <aside aria-label="Repository details" className="self-start border-t border-fh-border pt-4 lg:col-start-2 lg:row-start-2">
          <CompositionBar token={token} handle={handle} repoName={repoName} refName={currentRef} />
          <ReleasesSection token={token} handle={handle} repoName={repoName} base={base} />
          <ContributorsSection token={token} handle={handle} repoName={repoName} refName={currentRef} />
        </aside>
      )}
    </div>
  );
}
