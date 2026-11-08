import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../ui";

/**
 * Small SVG charts for Insights (#256). Thin columns (at most 24px, a 2px gap,
 * 4px rounded ends at the data, square at the baseline), hairline solid
 * gridlines, one y-axis with clean compact ticks, a per-column hover tooltip
 * whose hit area is the column's whole band, and a data table twin, so no
 * value lives in the tooltip alone. Colours are design tokens, so the dark
 * theme gets its own steps.
 */

export type Column = { key: string; label: string; value: number };

const MAX_BAR = 24;
const GAP = 2;
const AXIS_W = 40;
const X_AXIS_H = 20;

/** 0 / 1K / 2.5M */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Clean axis ticks from 0 up past `max`: steps of 1, 2 or 5 × 10ⁿ, about four
 * of them, never less than 1 (these charts count commits and lines).
 */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
  const ticks: number[] = [];
  for (let t = 0; t < max + step; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks.length > 1 ? ticks : [0, step];
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.clientWidth);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref as React.RefObject<T>, width];
}

/** A column path: square at the baseline, 4px rounded at the data end (up or down). */
function columnPath(x: number, w: number, base: number, end: number): string {
  const h = Math.abs(base - end);
  if (h < 0.5) return "";
  const r = Math.min(4, w / 2, h);
  if (end < base) {
    return `M${x},${base} V${end + r} Q${x},${end} ${x + r},${end} H${x + w - r} Q${x + w},${end} ${x + w},${end + r} V${base} Z`;
  }
  return `M${x},${base} V${end - r} Q${x},${end} ${x + r},${end} H${x + w - r} Q${x + w},${end} ${x + w},${end - r} V${base} Z`;
}

type Tip = { x: number; y: number; lines: Array<{ value: string; label: string }> };

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-fh-border bg-fh-surface px-2.5 py-1.5 text-fh-xs shadow-lg"
      style={{ left: tip.x, top: tip.y - 6 }}
    >
      {tip.lines.map((l, i) => (
        <p key={i} className={i === 0 ? "font-semibold text-fh-fg" : "text-fh-fg-muted"}>
          {l.value} <span className="font-normal text-fh-fg-muted">{l.label}</span>
        </p>
      ))}
    </div>
  );
}

/** Geometry shared by both charts: one band per column, bars centred in their band. */
function bands(count: number, plotWidth: number) {
  const band = count > 0 ? plotWidth / count : plotWidth;
  const bar = Math.max(1, Math.min(MAX_BAR, band - GAP));
  return { band, bar, x: (i: number) => AXIS_W + i * band + (band - bar) / 2 };
}

/** x-axis labels: at most ~8, spread evenly, from the columns' own labels. */
function xTicks(columns: Column[], tickLabel?: (c: Column, i: number) => string | null): Array<{ i: number; text: string }> {
  if (tickLabel) {
    return columns.map((c, i) => ({ i, text: tickLabel(c, i) })).filter((t): t is { i: number; text: string } => !!t.text);
  }
  const every = Math.max(1, Math.ceil(columns.length / 8));
  return columns.map((c, i) => ({ i, text: c.label })).filter((_, i) => i % every === 0);
}

/**
 * One series of columns over a shared x (weeks, days). `unit` names the value
 * in the tooltip ("commits"); `selected` lifts one column, `onSelect` makes
 * them clickable.
 */
export function ColumnChart({
  columns,
  height = 160,
  unit,
  ariaLabel,
  maxValue,
  tickLabel,
  selected,
  onSelect,
  compactAxis,
}: {
  columns: Column[];
  height?: number;
  unit: string;
  ariaLabel: string;
  /** Share a y-scale across small multiples. */
  maxValue?: number;
  tickLabel?: (c: Column, i: number) => string | null;
  selected?: number;
  onSelect?: (i: number) => void;
  /** Small multiples: no axis labels, a top tick only. */
  compactAxis?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const plotH = height - (compactAxis ? 0 : X_AXIS_H);
  const ticks = niceTicks(maxValue ?? Math.max(0, ...columns.map((c) => c.value)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => plotH - (v / top) * (plotH - 4);
  const { band, bar, x } = bands(columns.length, Math.max(0, width - AXIS_W));

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {(compactAxis ? [top] : ticks).map((t) => (
            <g key={t}>
              <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-fh-border-muted" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={AXIS_W - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fh-fg-muted text-[10px] tabular-nums">
                {compact(t)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => (
            <g key={c.key}>
              <path d={columnPath(x(i), bar, plotH, y(c.value))} className={cx("fill-fh-accent-emphasis transition-opacity", selected != null && selected !== i && "opacity-40")} />
              {/* The whole band is the hit target, not just the painted column. */}
              <rect
                x={AXIS_W + i * band}
                y={0}
                width={band}
                height={plotH}
                fill="transparent"
                className={onSelect ? "cursor-pointer" : undefined}
                onMouseEnter={() => setTip({ x: x(i) + bar / 2, y: y(c.value), lines: [{ value: `${c.value.toLocaleString()} ${unit}`, label: "" }, { value: c.label, label: "" }] })}
                onClick={onSelect ? () => onSelect(i) : undefined}
              />
            </g>
          ))}
          {!compactAxis &&
            xTicks(columns, tickLabel).map((t) => (
              <text key={t.i} x={x(t.i) + bar / 2} y={height - 4} textAnchor="middle" className="fill-fh-fg-muted text-[10px]">
                {t.text}
              </text>
            ))}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/**
 * Two measures around one zero line (#256's code frequency): `up` above the
 * baseline, `down` below it, on a single shared scale, never two axes. Position
 * tells them apart as well as colour, and the legend names both.
 */
export function DivergingColumnChart({
  columns,
  height = 220,
  up,
  down,
  ariaLabel,
  tickLabel,
}: {
  columns: Array<{ key: string; label: string; up: number; down: number }>;
  height?: number;
  up: { name: string; className: string };
  down: { name: string; className: string };
  ariaLabel: string;
  tickLabel?: (c: Column, i: number) => string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const plotH = height - X_AXIS_H;
  const max = Math.max(1, ...columns.map((c) => Math.max(c.up, c.down)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const mid = plotH / 2;
  const y = (v: number) => mid - (v / top) * (mid - 4);
  const { band, bar, x } = bands(columns.length, Math.max(0, width - AXIS_W));
  const asColumns = columns.map((c) => ({ key: c.key, label: c.label, value: c.up }));

  return (
    <div>
      <ul className="mb-2 flex gap-4 text-fh-xs text-fh-fg-muted" aria-label="Legend">
        {[up, down].map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" className={s.className} /></svg>
            {s.name}
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative w-full" onMouseLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
            {[...ticks.slice(1).map((t) => -t).reverse(), ...ticks].map((t) => (
              <g key={t}>
                <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-fh-border-muted" strokeWidth={t === 0 ? 1.5 : 1} shapeRendering="crispEdges" />
                <text x={AXIS_W - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fh-fg-muted text-[10px] tabular-nums">
                  {t === 0 ? "0" : `${t > 0 ? "+" : "−"}${compact(Math.abs(t))}`}
                </text>
              </g>
            ))}
            {columns.map((c, i) => (
              <g key={c.key}>
                <path d={columnPath(x(i), bar, mid, y(c.up))} className={up.className} />
                <path d={columnPath(x(i), bar, mid, y(-c.down))} className={down.className} />
                <rect
                  x={AXIS_W + i * band}
                  y={0}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() =>
                    setTip({
                      x: x(i) + bar / 2,
                      y: y(c.up),
                      lines: [
                        { value: `+${c.up.toLocaleString()}`, label: up.name.toLowerCase() },
                        { value: `−${c.down.toLocaleString()}`, label: down.name.toLowerCase() },
                        { value: c.label, label: "" },
                      ],
                    })
                  }
                />
              </g>
            ))}
            {xTicks(asColumns, tickLabel).map((t) => (
              <text key={t.i} x={x(t.i) + bar / 2} y={height - 4} textAnchor="middle" className="fill-fh-fg-muted text-[10px]">
                {t.text}
              </text>
            ))}
          </svg>
        )}
        <Tooltip tip={tip} />
      </div>
    </div>
  );
}

/** The table twin every chart carries (values without hovering). */
export function DataTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: Array<Array<string | number>> }) {
  return (
    <details className="mt-3 text-fh-sm">
      <summary className="cursor-pointer text-fh-xs text-fh-fg-muted hover:text-fh-fg">Show the data as a table</summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-md border border-fh-border">
        <table className="w-full text-left text-fh-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-fh-canvas text-fh-fg-muted">
            <tr>{headers.map((h) => <th key={h} className="px-3 py-1.5 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-fh-border-muted tabular-nums">
            {rows.map((r, i) => (
              <tr key={i}>{r.map((v, j) => <td key={j} className="px-3 py-1 text-fh-fg">{typeof v === "number" ? v.toLocaleString() : v}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
