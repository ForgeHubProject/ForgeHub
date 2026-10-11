import { useEffect, useMemo, useState } from "react";
import { getComposition } from "../../api";
import { Skeleton, cx } from "../../ui";
import { SidebarSection } from "./SidebarSection";
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

/**
 * The repository's formats by byte share, in the Code tab's sidebar (#208) —
 * ForgeHub's answer to GitHub's "Languages", and the most telling thing about a
 * hardware repository. The bar, then every format as a row: colour, name, the
 * semantic-diff mark, share.
 */
export function CompositionBar({ token, handle, repoName, refName }: Props) {
  const [data, setData] = useState<Composition | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
      <SidebarSection title="Formats">
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="mt-3 h-3 w-2/3" />
      </SidebarSection>
    );
  }

  // Nothing to show for an empty repo or a failed fetch — stay out of the way.
  if (failed || !data || data.totalFiles === 0 || colored.length === 0) return null;

  return (
    <SidebarSection title="Formats">
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

      <ul className="mt-3 list-none m-0 p-0 space-y-1.5">
        {colored.map(({ seg, color }) => (
          <li
            key={seg.format}
            className="flex items-center gap-2 text-fh-sm"
            title={`${seg.fileCount} ${seg.fileCount === 1 ? "file" : "files"}`}
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="min-w-0 truncate font-medium text-fh-fg">{seg.label}</span>
            {seg.optedIn && <SemanticMark />}
            {/* pct has one decimal: a sliver of bytes rounds to 0, which reads as "none". */}
            <span className="ml-auto tabular-nums text-fh-fg-muted">{seg.pct === 0 && seg.bytes > 0 ? "<0.1" : seg.pct}%</span>
          </li>
        ))}
      </ul>

      {hasSemantic && (
        <p className="mt-2.5 flex items-start gap-1.5 text-fh-xs text-fh-fg-subtle">
          <SemanticMark className="mt-0.5" />
          Semantically diffable — ForgeHub compares these by structure, not text.
        </p>
      )}
    </SidebarSection>
  );
}
