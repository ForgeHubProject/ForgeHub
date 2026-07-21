import { useEffect, useMemo, useState } from "react";
import { getComposition } from "../../api";
import { Skeleton, cx } from "../../ui";
import type { Composition, CompositionSegment } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  refName: string;
};

// A small, deterministic palette. These mid-tone hues are chosen to read on both
// the light (near-white) and dark (near-black) canvas — segments carry their own
// fill so they never depend on the surface token. "Other" is a fixed neutral.
const PALETTE = [
  "#3b82f6", // blue
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#dc2626", // red
  "#0891b2", // cyan
  "#ca8a04", // gold
  "#db2777", // pink
  "#65a30d", // lime
  "#0d9488", // teal
  "#7c3aed", // violet
  "#c2410c", // rust
];
const OTHER_COLOR = "#8b949e";

/** Deterministic color for a segment by its position (Other is always neutral). */
function colorFor(seg: CompositionSegment, index: number): string {
  return seg.format === "other" ? OTHER_COLOR : PALETTE[index % PALETTE.length];
}

// A faint diagonal hatch overlaid on opted-in (semantically diffable) segments so
// the FHR distinction is visible on the bar itself, in either theme.
const SEMANTIC_HATCH =
  "repeating-linear-gradient(45deg, rgba(255,255,255,0.30) 0, rgba(255,255,255,0.30) 1.5px, transparent 1.5px, transparent 5px)";

function SemanticMark({ className }: { className?: string }) {
  return (
    <span
      title="Semantically diffable — ForgeHub tracks changes by structure, not text"
      className={cx("inline-flex items-center gap-0.5 text-fh-accent-fg", className)}
    >
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="5" y="0" width="7.07" height="7.07" transform="rotate(45 5 0)" fill="currentColor" />
      </svg>
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={cx("transition-transform", open && "rotate-180")}
    >
      <path fillRule="evenodd" d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z" />
    </svg>
  );
}

export function CompositionBar({ token, handle, repoName, refName }: Props) {
  const [data, setData] = useState<Composition | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!refName) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getComposition(token, handle, repoName, refName)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, refName]);

  const colored = useMemo(
    () => (data?.segments ?? []).map((seg, i) => ({ seg, color: colorFor(seg, i) })),
    [data],
  );
  const hasSemantic = colored.some(({ seg }) => seg.optedIn);

  if (loading) {
    return (
      <div className="mb-4 rounded-md border border-fh-border bg-fh-surface p-3">
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="mt-3 h-3 w-2/3" />
      </div>
    );
  }

  // Nothing to show for an empty repo or a failed fetch — stay out of the way.
  if (failed || !data || data.totalFiles === 0 || colored.length === 0) return null;

  // Identity summary: "43% glTF scene · 20% CSV · 12% Markdown".
  const summary = colored.slice(0, 3).map(({ seg }) => `${seg.pct}% ${seg.label}`).join("  ·  ");

  return (
    <section aria-label="Format composition" className="mb-4 rounded-md border border-fh-border bg-fh-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-fh-sm font-semibold text-fh-fg">Formats</span>
          <span className="truncate text-fh-xs text-fh-fg-muted" title={summary}>{summary}</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-fh-xs font-medium text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg cursor-pointer"
        >
          {open ? "Hide" : "Details"}
          <ChevronIcon open={open} />
        </button>
      </div>

      {/* The thin segmented bar. flex-grow = bytes → widths exactly proportional. */}
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-fh-neutral-muted"
        role="img"
        aria-label={colored.map(({ seg }) => `${seg.label} ${seg.pct}%`).join(", ")}
      >
        {colored.map(({ seg, color }) => (
          <div
            key={seg.format}
            title={`${seg.label} — ${seg.pct}%${seg.optedIn ? " (semantic diff on)" : ""}`}
            className="h-full"
            style={{
              flexGrow: Math.max(seg.bytes, 1),
              flexBasis: 0,
              backgroundColor: color,
              ...(seg.optedIn ? { backgroundImage: SEMANTIC_HATCH } : {}),
            }}
          />
        ))}
      </div>

      {/* Expandable legend with per-format percentages. */}
      {open && (
        <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {colored.map(({ seg, color }) => (
            <li key={seg.format} className="flex items-center gap-2 text-fh-sm">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color, ...(seg.optedIn ? { backgroundImage: SEMANTIC_HATCH } : {}) }}
              />
              <span className="font-medium text-fh-fg">{seg.label}</span>
              {seg.optedIn && <SemanticMark />}
              <span className="ml-auto tabular-nums text-fh-fg-muted">{seg.pct}%</span>
              <span className="w-16 text-right tabular-nums text-fh-xs text-fh-fg-subtle">
                {seg.fileCount} {seg.fileCount === 1 ? "file" : "files"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {open && hasSemantic && (
        <p className="mt-2.5 flex items-center gap-1.5 border-t border-fh-border pt-2.5 text-fh-xs text-fh-fg-subtle">
          <SemanticMark />
          Semantically diffable — ForgeHub compares these by structure, not text.
        </p>
      )}
    </section>
  );
}
