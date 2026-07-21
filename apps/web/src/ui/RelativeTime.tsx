import { useEffect, useState } from "react";

type Props = {
  /** ISO string, epoch ms, or Date. */
  date: string | number | Date;
  className?: string;
  /** Refresh cadence in ms for live "x minutes ago" text (default 60s). */
  tickMs?: number;
};

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relative(from: Date): string {
  let delta = (from.getTime() - Date.now()) / 1000; // seconds, negative for past
  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(delta) < amount) return rtf.format(Math.round(delta), unit);
    delta /= amount;
  }
  return from.toISOString();
}

/**
 * Renders a relative time ("3 days ago") that ticks itself up to date, with the
 * full absolute timestamp exposed via the `title` attribute on hover.
 */
export function RelativeTime({ date, className, tickMs = 60_000 }: Props) {
  const parsed = date instanceof Date ? date : new Date(date);
  const valid = !Number.isNaN(parsed.getTime());
  const [, force] = useState(0);

  useEffect(() => {
    if (!valid) return;
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [valid, tickMs]);

  if (!valid) return <span className={className}>unknown</span>;

  return (
    <time dateTime={parsed.toISOString()} title={parsed.toLocaleString()} className={className}>
      {relative(parsed)}
    </time>
  );
}
