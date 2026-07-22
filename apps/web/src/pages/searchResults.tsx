/**
 * Result renderers for the two ForgeHub-specific search types on SearchPage:
 *
 *  - Code   — per-file cards of `git grep` hits. Each matching line deep-links to
 *             the blob at the exact `#L` permalink anchor (code-nav line anchors),
 *             pinned to the canonical commit `sha` so the link never rots.
 *  - Entities — FHR structural hits: a scene node's name + kind + the artifact it
 *             came from. This is the identity feature — searching *structure*,
 *             not bytes, which a byte-level code search structurally cannot do.
 *
 * Icons are Octicon-style 16px marks in `currentColor`, matching listShared.
 */
import { Link } from "react-router-dom";
import type { SearchCodeResult, SearchEntityResult } from "../types";
import { Badge, cx } from "../ui";

// ── Icons ────────────────────────────────────────────────────────────────────
type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

/** File-with-code mark — the "Code" search type. */
export const CodeFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z" />
  </Svg>
);

/** Cube/module mark — the FHR "Entities" search type (structural artifacts). */
export const CubeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M7.628.334a.75.75 0 01.744 0l5.5 3.143A.75.75 0 0114.25 4.13v7.74a.75.75 0 01-.378.652l-5.5 3.143a.75.75 0 01-.744 0l-5.5-3.143a.75.75 0 01-.378-.652V4.13a.75.75 0 01.378-.653L7.628.334zM3.25 5.174v6.263l4 2.286V7.46l-4-2.286zm5.5 8.549l4-2.286V5.174l-4 2.286v6.263zM8 6.161l3.939-2.251L8 1.658 4.061 3.91 8 6.161z" />
  </Svg>
);

// ── Match-line highlighting ──────────────────────────────────────────────────

/**
 * Wrap each case-insensitive literal occurrence of `query` in `text` with an
 * emphasized `<mark>`. Only fixed-string queries are highlighted; when the query
 * is empty or absent (e.g. regex mode) the raw text is returned unchanged.
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(needle, cursor);
  if (found < 0) return text;
  let key = 0;
  while (found >= 0) {
    if (found > cursor) out.push(text.slice(cursor, found));
    out.push(
      <mark key={key++} className="rounded-sm bg-fh-warning-muted px-0.5 font-semibold text-fh-fg">
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    cursor = found + needle.length;
    found = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

// ── Code result card ─────────────────────────────────────────────────────────

/** Blob permalink to an exact line: `/owner/name/blob/<sha>/<path>#L<line>`. */
function blobLineHref(r: SearchCodeResult, line: number): string {
  return `/${r.repo.ownerHandle}/${r.repo.name}/blob/${r.sha}/${r.path}#L${line}`;
}

export function CodeResultCard({ result, query }: { result: SearchCodeResult; query: string }) {
  const repoPath = `${result.repo.ownerHandle}/${result.repo.name}`;
  const fileHref = `/${repoPath}/blob/${result.sha}/${result.path}`;
  return (
    <div className="overflow-hidden rounded-md border border-fh-border bg-fh-surface">
      {/* File header */}
      <div className="flex items-center gap-2 border-b border-fh-border bg-fh-surface-muted px-3 py-2">
        <CodeFileIcon size={16} className="shrink-0 text-fh-fg-muted" />
        <div className="min-w-0 flex-1 truncate text-fh-sm">
          <Link to={`/${repoPath}`} className="text-fh-fg-muted hover:text-fh-accent-fg hover:underline">
            {repoPath}
          </Link>
          <span className="px-1 text-fh-fg-subtle">/</span>
          <Link to={fileHref} className="font-semibold text-fh-fg hover:text-fh-accent-fg hover:underline">
            {result.path}
          </Link>
        </div>
        <span className="shrink-0 text-fh-xs text-fh-fg-subtle">
          {result.matches.length} {result.matches.length === 1 ? "match" : "matches"}
        </span>
      </div>

      {/* Matching lines */}
      <div className="divide-y divide-fh-border-muted font-mono text-fh-xs">
        {result.matches.map((m) => (
          <Link
            key={m.line}
            to={blobLineHref(result, m.line)}
            className="group flex items-start gap-3 px-3 py-1 transition-colors hover:bg-fh-surface-muted"
          >
            <span className="w-10 shrink-0 select-none text-right text-fh-fg-subtle group-hover:text-fh-accent-fg">
              {m.line}
            </span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-fh-fg">
              {highlightMatch(m.preview, query)}
            </code>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Entity result row ────────────────────────────────────────────────────────

/**
 * Link an entity to the artifact it came from: the blob permalink at the
 * snapshot's commit (which renders the FHR viewer for that file). When the
 * snapshot has no git commit (e.g. a direct upload) we fall back to the repo.
 */
function entitySourceHref(r: SearchEntityResult): string {
  const repoPath = `/${r.repo.ownerHandle}/${r.repo.name}`;
  return r.snapshot.gitCommitSha
    ? `${repoPath}/blob/${r.snapshot.gitCommitSha}/${r.snapshot.sourceFile}`
    : repoPath;
}

export function EntityResultRow({ result, query }: { result: SearchEntityResult; query: string }) {
  const repoPath = `${result.repo.ownerHandle}/${result.repo.name}`;
  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-fh-surface-muted">
      <span className="mt-0.5 shrink-0 text-fh-accent-fg">
        <CubeIcon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={entitySourceHref(result)}
            className="font-mono text-fh-sm font-semibold text-fh-fg hover:text-fh-accent-fg hover:underline"
          >
            {highlightMatch(result.name, query)}
          </Link>
          <Badge tone="accent">{result.kind}</Badge>
        </div>
        <p className="mt-1 truncate text-fh-xs text-fh-fg-subtle">
          {result.path && <span className="font-mono text-fh-fg-muted">{result.path}</span>}
          {result.path && <span className="px-1.5">·</span>}
          <Link to={`/${repoPath}`} className="text-fh-fg-muted hover:text-fh-accent-fg hover:underline">
            {repoPath}
          </Link>
          <span className="px-1">/</span>
          <Link to={entitySourceHref(result)} className="text-fh-fg-muted hover:text-fh-accent-fg hover:underline">
            {result.snapshot.sourceFile}
          </Link>
        </p>
      </div>
    </div>
  );
}
