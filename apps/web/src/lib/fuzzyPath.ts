// Fuzzy matching for "Go to file" (#223): the query's characters must appear
// in the path in order; the score favours what a person means when they type
// a few letters of a file name.

export type PathMatch = { path: string; score: number; /** Indexes of the matched characters, for highlighting. */ hits: number[] };

function isWordStart(path: string, i: number): boolean {
  if (i === 0) return true;
  const before = path[i - 1]!;
  if ("/._- ".includes(before)) return true;
  return before === before.toLowerCase() && path[i] !== path[i]!.toLowerCase();
}

/** Can `q` (from its index k) still be matched in `p` at or after `from`? */
function fits(p: string, q: string, k: number, from: number): boolean {
  let at = from;
  for (let j = k; j < q.length; j++) {
    at = p.indexOf(q[j]!, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/**
 * One way to line `q` up with `p` from `start`: each character at its earliest
 * occurrence, or, with `preferWords`, at a later word start or right after the
 * previous hit when the rest of the query still fits after it.
 */
function align(path: string, p: string, q: string, start: number, preferWords: boolean): number[] | null {
  const hits: number[] = [];
  let from = start;
  for (let k = 0; k < q.length; k++) {
    const ch = q[k]!;
    let at = p.indexOf(ch, from);
    if (at < 0) return null;
    if (preferWords) {
      const prev = hits[hits.length - 1];
      for (let i = at; i < p.length; i++) {
        if (p[i] !== ch) continue;
        const good = (prev !== undefined && i === prev + 1) || isWordStart(path, i);
        if (good && fits(p, q, k + 1, i + 1)) {
          at = i;
          break;
        }
      }
    }
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

function scoreHits(path: string, p: string, q: string, hits: number[], nameStart: number): number {
  let score = 0;
  hits.forEach((at, k) => {
    score += 1;
    if (k > 0 && at === hits[k - 1]! + 1) score += 5;
    if (isWordStart(path, at)) score += 3;
    if (at >= nameStart) score += 2;
  });
  if (p.slice(nameStart).startsWith(q)) score += 10;
  return score - path.length / 100;
}

/**
 * Score `path` against `query` (case-insensitive, spaces ignored), or null when
 * the query's characters don't all appear in order. Higher is better:
 * consecutive characters, characters at the start of a segment or word, and
 * characters in the file name (after the last "/") all count extra; shorter
 * paths win ties. Several alignments are tried and the best one kept.
 */
export function scorePath(path: string, query: string): PathMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { path, score: 0, hits: [] };
  const p = path.toLowerCase();
  if (!fits(p, q, 0, 0)) return null;
  const nameStart = path.lastIndexOf("/") + 1;
  let best: PathMatch | null = null;
  for (const start of nameStart > 0 ? [0, nameStart] : [0]) {
    for (const preferWords of [false, true]) {
      const hits = align(path, p, q, start, preferWords);
      if (!hits) continue;
      const score = scoreHits(path, p, q, hits, nameStart);
      if (!best || score > best.score) best = { path, score, hits };
    }
  }
  return best;
}

/** How many cheaply-ranked candidates get the full scoring. */
const RESCORE = 300;

// Lowercased copies, made once per path list rather than on every keystroke.
const lowered = new WeakMap<readonly string[], string[]>();

/**
 * A rough score from the earliest alignment starting at `start`, or NaN when
 * the query doesn't fit from there: no allocations, no per-character string
 * work, so it can run over every path on each search.
 */
function cheapScore(p: string, q: string, start: number, nameStart: number): number {
  let score = 0;
  let at = start;
  let prev = -2;
  for (let k = 0; k < q.length; k++) {
    at = p.indexOf(q[k]!, at);
    if (at < 0) return Number.NaN;
    if (at === prev + 1) score += 5;
    if (at >= nameStart) score += 2;
    prev = at;
    at++;
  }
  if (p.startsWith(q, nameStart)) score += 10;
  return score - p.length / 100;
}

/**
 * The best `limit` matches of `query` among `paths`, best first. Every path
 * gets a cheap score (one alignment); only the best RESCORE are scored fully,
 * so a query matching a hundred thousand paths stays fast enough to run as the
 * reader types.
 */
export function matchPaths(paths: readonly string[], query: string, limit = 50): PathMatch[] {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  let lows = lowered.get(paths);
  if (!lows) {
    lows = paths.map((x) => x.toLowerCase());
    lowered.set(paths, lows);
  }
  const cheap: { i: number; score: number }[] = [];
  for (let i = 0; i < paths.length; i++) {
    const p = lows[i]!;
    const nameStart = p.lastIndexOf("/") + 1;
    let score = nameStart > 0 ? cheapScore(p, q, nameStart, nameStart) : Number.NaN;
    if (Number.isNaN(score)) score = cheapScore(p, q, 0, nameStart);
    if (!Number.isNaN(score)) cheap.push({ i, score });
  }
  cheap.sort((a, b) => b.score - a.score);
  const out: PathMatch[] = [];
  for (const c of cheap.slice(0, Math.max(RESCORE, limit))) {
    const m = scorePath(paths[c.i]!, query);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}
