/**
 * Presentational atoms for the commit history + commit-detail views. These are
 * the small, reusable chrome pieces the RepoCommitsTab composes — built only
 * from `fh-*` tokens and ui/ primitives (see apps/web/DESIGN.md). They are
 * deliberately dumb: no data fetching, no routing decisions.
 */
import { useCallback, useState } from "react";
import { Badge, Tooltip, cx } from "../../ui";
import type { BadgeTone } from "../../ui";
import type { FileDiff } from "../../types";

// ─── Local icons ───────────────────────────────────────────────────────────────
// Octicon-style 16px marks in currentColor for the few glyphs the shared ui/
// icon set doesn't carry (copy, commit-node, file, chevron). Page-level icons,
// consistent with rule §5.8 of DESIGN.md.

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
  </Svg>
);

export const CommitNodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
  </Svg>
);

export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5Zm5.75.56v2.19c0 .138.112.25.25.25h2.19Z" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
  </Svg>
);

// ─── Day heading ───────────────────────────────────────────────────────────────

/** "Jul 20, 2026" — abbreviated month, local calendar day. */
export function formatDayHeading(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ─── Short-SHA chip with copy-on-click ──────────────────────────────────────────

type ShaChipProps = {
  sha: string;
  /** Length of the abbreviated hash shown (default 7). */
  length?: number;
  className?: string;
};

/**
 * A monospace short-SHA pill that copies the FULL sha to the clipboard on click,
 * flashing a check for confirmation. Subtle border that strengthens on hover.
 */
export function ShaChip({ sha, length = 7, className }: ShaChipProps) {
  const short = sha.slice(0, length);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [sha]);

  return (
    <Tooltip label={copied ? "Copied" : "Copy full SHA"}>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy commit ${short}`}
        className={cx(
          "inline-flex items-center gap-1.5 font-mono text-fh-xs leading-none",
          "rounded-md border px-2 py-1 transition-colors",
          copied
            ? "border-fh-success-fg/40 text-fh-success-fg bg-fh-success-muted"
            : "border-fh-border bg-fh-surface-muted text-fh-fg-muted hover:border-fh-border-strong hover:text-fh-fg",
          className,
        )}
      >
        <span>{short}</span>
        {copied ? <CheckMark /> : <CopyIcon size={12} className="opacity-70" />}
      </button>
    </Tooltip>
  );
}

function CheckMark() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

// ─── File change-type badge ─────────────────────────────────────────────────────

const STATUS_TONE: Record<FileDiff["status"], BadgeTone> = {
  added: "success",
  deleted: "danger",
  renamed: "accent",
  modified: "neutral",
};

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "Modified",
};

/**
 * A tag for a file's change type. Modified files get no tag (the +/- counts
 * carry the signal, matching GitHub) to keep the file list quiet.
 */
export function ChangeTypeBadge({ status }: { status: FileDiff["status"] }) {
  if (status === "modified") return null;
  return (
    <Badge tone={STATUS_TONE[status]} pill={false}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// ─── +additions / −deletions counts ─────────────────────────────────────────────

/** Monospace +N −M pair, colored via success/danger tokens. Zero sides drop. */
export function DiffCounts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-mono text-fh-xs leading-none", className)}>
      {additions > 0 && <span className="text-fh-success-fg">+{additions}</span>}
      {deletions > 0 && <span className="text-fh-danger-fg">&minus;{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="text-fh-fg-subtle">0</span>}
    </span>
  );
}

// ─── GitHub-style 5-square diffstat ─────────────────────────────────────────────

/** Compact green/red proportion bar (5 squares) summarizing a changeset. */
export function DiffStatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const squares = 5;
  const total = additions + deletions;
  let greens = 0;
  let reds = 0;
  if (total > 0) {
    greens = additions > 0 ? Math.min(squares, Math.max(1, Math.round((additions / total) * squares))) : 0;
    reds = deletions > 0 ? Math.min(squares - greens, Math.max(1, Math.round((deletions / total) * squares))) : 0;
  }
  return (
    <span
      className="inline-flex items-center gap-[2px] align-middle"
      title={`${additions} addition${additions !== 1 ? "s" : ""} & ${deletions} deletion${deletions !== 1 ? "s" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: squares }).map((_, i) => (
        <span
          key={i}
          className={cx(
            "h-2 w-2 rounded-[2px]",
            i < greens ? "bg-fh-success-fg" : i < greens + reds ? "bg-fh-danger-fg" : "bg-fh-neutral-muted",
          )}
        />
      ))}
    </span>
  );
}
