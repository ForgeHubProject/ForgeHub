import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRawBlob, getBlame, getBlob, getBlobMeta, resolveRef, type BlobMeta } from "../api";
import { formatBytes, lineStats } from "../lib/fileFacts";
import { historyUrl } from "../pages/repo/LatestCommitBar";
import { convertTargets, downloadConverted, loadConvertFormats } from "../lib/convert";
import { Breadcrumbs, DropdownItem, DropdownLabel, DropdownMenu, Skeleton, Tooltip, cx, useToast } from "../ui";
import type { Crumb } from "../ui";
import type { BlameHunk } from "../types";
import { useSemanticFormatsReady } from "../lib/fhrFormats";
import {
  extensionKey,
  isSemanticFilename,
  resolveFileViewer,
  semanticViewExtensions,
} from "../views/fileViewerRegistry";
import { CodeViewer } from "../views/viewers/CodeViewer";
import type { LineRange } from "../views/fileViewerTypes";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  ref: string;
  path: string;
  repoBase: string;
  /** Drawn between the breadcrumb and the file (the file page's latest-commit bar, #224). */
  beforeFile?: React.ReactNode;
};

const SHA_RE = /^[0-9a-f]{40}$/;

/** Parse a `#L10` / `#L10-L20` location hash into an inclusive line range. */
function parseLineHash(hash: string): LineRange | null {
  const m = hash.match(/^#L(\d+)(?:-L(\d+))?$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function rangeToHash(r: LineRange): string {
  return r.start === r.end ? `#L${r.start}` : `#L${r.start}-L${r.end}`;
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
      <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.47 10.78a.75.75 0 001.06 0l3.75-3.75a.75.75 0 00-1.06-1.06L8.75 8.44V1.75a.75.75 0 00-1.5 0v6.69L4.78 5.97a.75.75 0 00-1.06 1.06l3.75 3.75zM3.75 13a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z" />
    </svg>
  );
}

function ConvertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z" />
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z" />
    </svg>
  );
}

/** A small button in the blob header action row. */
function HeaderAction({ onClick, icon, children, href, active }: {
  onClick?: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  href?: string;
  active?: boolean;
}) {
  const cls = cx(
    "inline-flex items-center gap-1.5 h-6 px-2 text-fh-sm bg-fh-surface",
    "border rounded-md transition-colors cursor-pointer whitespace-nowrap",
    active
      ? "text-fh-fg border-fh-border-strong bg-fh-surface-muted"
      : "text-fh-fg-muted border-fh-border hover:bg-fh-surface-muted hover:text-fh-fg hover:border-fh-border-strong",
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cls}>
      {icon}
      {children}
    </button>
  );
}

export function BlobViewer({ token, handle, repoName, ref, path, repoBase, beforeFile }: Props) {
  const { toast } = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedRange, setSelectedRange] = useState<LineRange | null>(() => parseLineHash(window.location.hash));
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<BlameHunk[] | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);
  const didScrollRef = useRef(false);

  const filename = path.split("/").pop() ?? path;
  const pathParts = path.split("/");

  // "Convert to…": the 3D formats this file can be written as (FHR SPEC §7). The
  // list comes from the server once per session; a server without the endpoint,
  // or a file that is not a 3D format, simply offers nothing.
  const [targets, setTargets] = useState<string[]>([]);
  const [converting, setConverting] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadConvertFormats().then((all) => { if (!cancelled) setTargets(convertTargets(all, filename)); });
    return () => { cancelled = true; };
  }, [filename]);
  const navigate = useNavigate();
  // Size and format for every file, from the tree: no download needed (#225).
  const [meta, setMeta] = useState<BlobMeta | null>(null);
  useEffect(() => {
    let live = true;
    setMeta(null);
    getBlobMeta(token, handle, repoName, ref, path)
      .then((m) => { if (live) setMeta(m); })
      .catch(() => { /* the header just omits the facts */ });
    return () => { live = false; };
  }, [token, handle, repoName, ref, path]);
  const stats = useMemo(() => (content === null ? null : lineStats(content)), [content]);

  // Manifest-mapped files (e.g. .glb) get the FHR renderer, which fetches its
  // own raw bytes — the text fetch below is skipped for them, because decoding
  // a binary model as a string is exactly the mojibake this path replaces.
  //
  // The fetch waits for the manifest to SETTLE, not merely for the set to be
  // non-empty: the set starts empty while the manifest is in flight, and
  // treating that gap as "not semantic" dispatched a doomed whole-binary text
  // fetch on every cold load of a .glb (and flashed the error card for files
  // past the text route's size cap). Settling is one cached round-trip per
  // app session, and a failed manifest settles empty so text files degrade to
  // exactly the old behavior rather than waiting forever.
  //
  // A renderer that draws diffs only (its bundle's `modes` omits "view") hands
  // the file back through onViewDeclined; from then on its extension is shown
  // like any other file, by the static registry with the text fetch below.
  const { extensions: manifestExts, settled: manifestSettled } = useSemanticFormatsReady();
  const [viewDeclined, setViewDeclined] = useState<ReadonlySet<string>>(() => new Set());
  const semanticExts = useMemo(
    () => semanticViewExtensions(manifestExts, viewDeclined),
    [manifestExts, viewDeclined],
  );
  const semantic = isSemanticFilename(filename, semanticExts);
  const Viewer = blameOn ? CodeViewer : resolveFileViewer(filename, semanticExts);
  const declineView = useCallback(() => {
    // Loading now, in the same render that drops `semantic`, so the "File not
    // found" branch (no content, not semantic) never shows before the fetch.
    setLoading(true);
    setViewDeclined((prev) => new Set(prev).add(extensionKey(filename)));
  }, [filename]);

  useEffect(() => {
    if (!manifestSettled) return; // still loading; the skeleton stays up
    if (semantic) {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBlob(token, handle, repoName, path, ref)
      .then((d) => { if (!cancelled) setContent(d.content); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load file"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, path, ref, semantic, manifestSettled]);

  // Keep the selection in sync with browser back/forward and manual hash edits.
  useEffect(() => {
    function onHashChange() { setSelectedRange(parseLineHash(window.location.hash)); }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Scroll the initially-anchored line into view once, after content renders.
  useEffect(() => {
    if (didScrollRef.current || content === null || !selectedRange) return;
    didScrollRef.current = true;
    const el = document.getElementById(`L${selectedRange.start}`);
    if (el) el.scrollIntoView({ block: "center" });
  }, [content, selectedRange]);

  const handleLineSelect = useCallback((line: number, shift: boolean) => {
    setSelectedRange((prev) => {
      const raw = shift && prev ? { start: prev.start, end: line } : { start: line, end: line };
      const norm = { start: Math.min(raw.start, raw.end), end: Math.max(raw.start, raw.end) };
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${rangeToHash(norm)}`);
      return norm;
    });
  }, []);

  function toggleBlame() {
    const next = !blameOn;
    setBlameOn(next);
    if (next && blame === null && !blameLoading) {
      setBlameLoading(true);
      getBlame(token, handle, repoName, path, ref)
        .then((d) => setBlame(d.hunks))
        .catch(() => setBlame([]))
        .finally(() => setBlameLoading(false));
    }
  }

  async function copyPermalink() {
    try {
      const sha = SHA_RE.test(ref) ? ref : (await resolveRef(token, handle, repoName, ref)).sha;
      const hash = selectedRange ? rangeToHash(selectedRange) : "";
      const url = `${window.location.origin}${repoBase}/blob/${sha}/${path}${hash}`;
      await navigator.clipboard.writeText(url);
      toast("Permalink copied", { tone: "success" });
    } catch {
      toast("Could not build permalink", { tone: "danger" });
    }
  }

  function copy() {
    if (!content) return;
    void navigator.clipboard.writeText(content).then(() => toast("File contents copied", { tone: "success" }));
  }

  async function download() {
    // Semantic files never had text content — download the true bytes instead.
    const blob = semantic
      ? await fetchRawBlob(token, handle, repoName, path, ref).catch(() => null)
      : content !== null
        ? new Blob([content], { type: "text/plain;charset=utf-8" })
        : null;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function convertTo(to: string) {
    if (converting) return;
    setConverting(to);
    try {
      // The endpoint addresses a commit, so a branch or tag is resolved first.
      const sha = SHA_RE.test(ref) ? ref : (await resolveRef(token, handle, repoName, ref)).sha;
      await downloadConverted(token, handle, repoName, path, sha, to);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Conversion failed", { tone: "danger" });
    } finally {
      setConverting(null);
    }
  }

  // Raw for every file (#225): text from what's already loaded; anything else
  // (a model, an image) fetched with the viewer's token, so private repos work.
  async function openRaw() {
    const blob = semantic || content === null
      ? await fetchRawBlob(token, handle, repoName, path, ref).catch(() => null)
      : new Blob([content], { type: "text/plain;charset=utf-8" });
    if (!blob) return toast("Could not load the raw file", { tone: "danger" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const crumbs: Crumb[] = [
    { label: repoName, to: repoBase },
    ...pathParts.slice(0, -1).map((part, i) => ({
      label: part,
      to: `${repoBase}/tree/${ref}/${pathParts.slice(0, i + 1).join("/")}`,
    })),
    { label: filename },
  ];

  function copyPath() {
    void navigator.clipboard.writeText(path).then(() => toast("Path copied", { tone: "success" }));
  }

  // The breadcrumb, with GitHub's copy-path button beside it (#223).
  const breadcrumb = (
    <div className="mb-3 flex min-w-0 items-center gap-1">
      <Breadcrumbs items={crumbs} className="min-w-0" />
      <Tooltip label="Copy path">
        <button
          type="button"
          onClick={copyPath}
          aria-label="Copy path"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg cursor-pointer"
        >
          <CopyIcon />
        </button>
      </Tooltip>
    </div>
  );

  if (loading) {
    return (
      <div>
        {breadcrumb}
        {beforeFile}
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          <div className="h-9 bg-fh-canvas border-b border-fh-border" />
          <div className="p-4 space-y-2">
            {[...Array(12)].map((_, i) => (
              <Skeleton key={i} className="h-3" width={`${55 + ((i * 17) % 40)}%`} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || (content === null && !semantic)) {
    return (
      <div>
        {breadcrumb}
        {beforeFile}
        <div className="border border-fh-border rounded-md bg-fh-surface p-8 text-center text-fh-danger-fg">
          {error ?? "File not found"}
        </div>
      </div>
    );
  }

  return (
    <div>
      {breadcrumb}
      {beforeFile}
      <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
        {/* File header (#225): Code | Blame and the file's facts on the left;
            Raw · Copy · Download, Permalink and a ⋯ menu on the right. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2 bg-fh-canvas border-b border-fh-border">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-fh-sm text-fh-fg-muted">
            {!semantic && (
              <div role="group" aria-label="View" className="inline-flex shrink-0 overflow-hidden rounded-md border border-fh-border">
                <button
                  type="button"
                  aria-pressed={!blameOn}
                  onClick={() => blameOn && toggleBlame()}
                  className={cx("h-6 px-2.5 text-fh-sm cursor-pointer", !blameOn ? "bg-fh-surface font-semibold text-fh-fg" : "bg-fh-canvas text-fh-fg-muted hover:text-fh-fg")}
                >
                  Code
                </button>
                <button
                  type="button"
                  aria-pressed={blameOn}
                  onClick={() => !blameOn && toggleBlame()}
                  className={cx("h-6 border-l border-fh-border px-2.5 text-fh-sm cursor-pointer", blameOn ? "bg-fh-surface font-semibold text-fh-fg" : "bg-fh-canvas text-fh-fg-muted hover:text-fh-fg")}
                >
                  Blame
                </button>
              </div>
            )}
            <span className="whitespace-nowrap" data-testid="file-facts">
              {stats && !semantic && (
                <>
                  <span className="font-semibold text-fh-fg">{stats.lines}</span> {stats.lines === 1 ? "line" : "lines"}{" "}
                  ({stats.loc} loc)
                  {meta && <span className="text-fh-border-strong"> · </span>}
                </>
              )}
              {meta && formatBytes(meta.size)}
              {meta?.format && (
                <span title={meta.format.semanticDiffs
                  ? `Diffs of ${meta.format.ext} files are semantic in this repository (FHR handler "${meta.format.handlerId}").`
                  : `FHR has a handler for ${meta.format.ext} ("${meta.format.handlerId}"); add ${meta.format.ext} to .forge/formats for semantic diffs.`}>
                  <span className="text-fh-border-strong"> · </span>
                  <span className="font-semibold text-fh-fg">{meta.format.ext.slice(1).toUpperCase()}</span>
                  {" · "}semantic diffs {meta.format.semanticDiffs ? "on" : "off"}
                </span>
              )}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <div role="group" aria-label="File" className="inline-flex overflow-hidden rounded-md border border-fh-border">
              {[
                { label: "Raw", icon: <CodeGlyph />, onClick: () => void openRaw(), show: true },
                { label: "Copy", icon: <CopyIcon />, onClick: copy, show: !semantic && content !== null },
                { label: "Download", icon: <DownloadIcon />, onClick: () => void download(), show: true },
              ].filter((a) => a.show).map((a, i) => (
                <Tooltip key={a.label} label={a.label === "Copy" ? "Copy file contents" : a.label === "Raw" ? "View raw" : "Download raw file"}>
                  <button
                    type="button"
                    onClick={a.onClick}
                    aria-label={a.label}
                    className={cx("inline-flex h-6 items-center gap-1.5 bg-fh-surface px-2 text-fh-sm text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg cursor-pointer", i > 0 && "border-l border-fh-border")}
                  >
                    {a.icon}
                    <span className="hidden sm:inline">{a.label}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
            <HeaderAction icon={<LinkIcon />} onClick={copyPermalink}>Permalink</HeaderAction>
            {targets.length > 0 && (
              <DropdownMenu
                align="end"
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 h-6 px-2 text-fh-sm bg-fh-surface border rounded-md transition-colors cursor-pointer whitespace-nowrap text-fh-fg-muted border-fh-border hover:bg-fh-surface-muted hover:text-fh-fg hover:border-fh-border-strong"
                  >
                    <ConvertIcon />
                    {converting ? `Converting to ${converting}…` : "Convert to…"}
                  </button>
                }
              >
                <DropdownLabel>Download as</DropdownLabel>
                {targets.map((to) => (
                  <DropdownItem key={to} onSelect={() => void convertTo(to)}>
                    {to}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            )}
            <DropdownMenu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label="More file actions"
                  className="inline-flex h-6 items-center rounded-md border border-fh-border bg-fh-surface px-2 text-fh-sm text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg hover:border-fh-border-strong cursor-pointer"
                >
                  ⋯
                </button>
              }
            >
              <DropdownItem onSelect={copyPath}>Copy path</DropdownItem>
              <DropdownItem onSelect={() => void copyPermalink()}>Copy permalink</DropdownItem>
              <DropdownItem onSelect={() => navigate(historyUrl(repoBase, ref, path))}>View history</DropdownItem>
              {!semantic && (
                <DropdownItem onSelect={toggleBlame}>{blameOn ? "View code" : "View blame"}</DropdownItem>
              )}
            </DropdownMenu>
          </div>
        </div>

        {blameOn && blameLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-3" width={`${50 + ((i * 13) % 40)}%`} />)}
          </div>
        ) : (
          <Viewer
            content={content ?? ""}
            path={path}
            filename={filename}
            gitRef={ref}
            repoBase={repoBase}
            token={token}
            selectedRange={selectedRange}
            onLineSelect={handleLineSelect}
            onViewDeclined={declineView}
            blame={blameOn ? blame : undefined}
          />
        )}
      </div>
    </div>
  );
}
