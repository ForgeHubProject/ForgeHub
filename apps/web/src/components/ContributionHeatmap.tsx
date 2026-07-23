import { useMemo } from "react";
import type { Contributions } from "../types";

// ─── Contribution calendar heatmap (issue #115) ────────────────────────────────
//
// A hand-rolled 53×7 SVG grid (no chart library). Cells are keyed by UTC date to
// match the API's UTC bucketing. Intensity uses the FH accent (cyan) ramp so it
// reads as part of the design system in both light and dark themes — level 0 is a
// neutral token, levels 1–4 are `accent-emphasis` at rising opacity. Every cell
// carries a native <title> tooltip (date + count).

const CELL = 11; // px square
const GAP = 3; // px between cells
const PITCH = CELL + GAP;
const LEFT_GUTTER = 28; // room for weekday labels
const TOP_GUTTER = 16; // room for month labels
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""]; // Sun..Sat, sparse
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Fill for an intensity level, using theme-aware accent tokens. */
function levelFill(level: number): string {
  switch (level) {
    case 1: return "rgb(var(--fh-accent-emphasis) / 0.30)";
    case 2: return "rgb(var(--fh-accent-emphasis) / 0.52)";
    case 3: return "rgb(var(--fh-accent-emphasis) / 0.76)";
    case 4: return "rgb(var(--fh-accent-emphasis))";
    default: return "rgb(var(--fh-neutral-muted))";
  }
}

/** Quartile-ish bucket of a count relative to the busiest day. */
function levelOf(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

function utcDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type Cell = { key: string; count: number; week: number; dow: number };

export function ContributionHeatmap({ data }: { data: Contributions }) {
  const { cells, weeks, monthLabels, max } = useMemo(() => {
    const counts = new Map<string, number>();
    let maxCount = 0;
    for (const d of data.days) {
      counts.set(d.date, d.count);
      if (d.count > maxCount) maxCount = d.count;
    }

    // Grid start = the Sunday on/before `from`; end = `to` (UTC).
    const start = utcDay(data.from);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = utcDay(data.to);

    const out: Cell[] = [];
    const months: { week: number; label: string }[] = [];
    let lastMonth = -1;
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = dateKey(cursor);
      const dow = cursor.getUTCDay();
      const week = Math.floor((cursor.getTime() - start.getTime()) / (7 * 86_400_000));
      out.push({ key, count: counts.get(key) ?? 0, week, dow });
      // Place a month label at the first week that lands in a new month (on its top row).
      if (dow === 0) {
        const m = cursor.getUTCMonth();
        if (m !== lastMonth) {
          months.push({ week, label: MONTHS[m] });
          lastMonth = m;
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const weekCount = out.length ? out[out.length - 1].week + 1 : 0;
    return { cells: out, weeks: weekCount, monthLabels: months, max: maxCount };
  }, [data]);

  const width = LEFT_GUTTER + weeks * PITCH;
  const height = TOP_GUTTER + 7 * PITCH;

  return (
    <div className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${pluralize(data.total, "contribution")} in the selected period`}
        className="block"
      >
        {/* Month labels */}
        {monthLabels.map((m) => (
          <text
            key={`${m.week}-${m.label}`}
            x={LEFT_GUTTER + m.week * PITCH}
            y={TOP_GUTTER - 5}
            style={{ fontSize: 10, fill: "rgb(var(--fh-fg-muted))" }}
          >
            {m.label}
          </text>
        ))}

        {/* Weekday labels */}
        {WEEKDAY_LABELS.map((label, dow) =>
          label ? (
            <text
              key={dow}
              x={0}
              y={TOP_GUTTER + dow * PITCH + CELL - 1}
              style={{ fontSize: 10, fill: "rgb(var(--fh-fg-muted))" }}
            >
              {label}
            </text>
          ) : null,
        )}

        {/* Day cells */}
        {cells.map((c) => {
          const level = levelOf(c.count, max);
          return (
            <rect
              key={c.key}
              x={LEFT_GUTTER + c.week * PITCH}
              y={TOP_GUTTER + c.dow * PITCH}
              width={CELL}
              height={CELL}
              rx={2}
              ry={2}
              style={{ fill: levelFill(level) }}
              stroke="rgb(var(--fh-border) / 0.6)"
              strokeWidth={1}
            >
              <title>{`${pluralize(c.count, "contribution")} on ${c.key}`}</title>
            </rect>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-2 text-fh-xs text-fh-fg-muted">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span
            key={l}
            className="inline-block rounded-[2px]"
            style={{
              width: CELL,
              height: CELL,
              backgroundColor: levelFill(l),
              boxShadow: "inset 0 0 0 1px rgb(var(--fh-border) / 0.6)",
            }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
