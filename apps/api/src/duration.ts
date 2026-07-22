/**
 * Human duration ⇄ minutes, using GitLab time-tracking semantics.
 *
 * Supported units: `w` (week), `d` (day), `h` (hour), `m` (minute). The
 * week/day conversions follow GitLab's defaults rather than wall-clock time:
 *
 *   1w = 5d   (a five-day work week)
 *   1d = 8h   (an eight-hour work day)
 *   1h = 60m
 *
 * So `1w` is 40 working hours (2400 minutes), NOT 168. This module is pure
 * (no I/O) and unit-tested directly.
 */

export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 8; // GitLab default: 1d = 8h
export const DAYS_PER_WEEK = 5; // GitLab default: 1w = 5d

const UNIT_MINUTES = {
  m: 1,
  h: MINUTES_PER_HOUR,
  d: HOURS_PER_DAY * MINUTES_PER_HOUR,
  w: DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR,
} as const;

type Unit = keyof typeof UNIT_MINUTES;

// A well-formed duration is one or more `<integer><unit>` chunks, optionally
// preceded by a sign. Whitespace between chunks is allowed (`1d 4h`).
const WHOLE_RE = /^(?:\d+(?:w|d|h|m))+$/;
const CHUNK_RE = /(\d+)(w|d|h|m)/g;

/**
 * Parse a GitLab-style duration string into whole minutes.
 *
 * Accepts combined units (`2h30m`), spaced units (`1d 4h`), and — for `/spend`
 * subtractions — a leading `-` (or `+`). Returns `null` when the input is empty
 * or not a valid duration (a bare number with no unit is rejected on purpose,
 * so `/estimate 90` must be written `/estimate 90m`).
 */
export function parseDuration(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = input.trim().toLowerCase();
  if (s === "") return null;

  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1).trimStart();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trimStart();
  }

  // Collapse internal whitespace so `1d 4h` validates the same as `1d4h`.
  const compact = s.replace(/\s+/g, "");
  if (compact === "" || !WHOLE_RE.test(compact)) return null;

  let total = 0;
  for (const match of compact.matchAll(CHUNK_RE)) {
    total += Number(match[1]) * UNIT_MINUTES[match[2] as Unit];
  }
  return sign * total;
}

/**
 * Render whole minutes as a compact GitLab-style duration (`"1d 2h 30m"`),
 * greedily decomposing into w/d/h/m. Non-positive input renders as `"0m"`.
 */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded <= 0) return "0m";

  let rem = rounded;
  const parts: string[] = [];
  for (const unit of ["w", "d", "h", "m"] as const) {
    const size = UNIT_MINUTES[unit];
    const n = Math.floor(rem / size);
    if (n > 0) {
      parts.push(`${n}${unit}`);
      rem -= n * size;
    }
  }
  return parts.join(" ");
}
