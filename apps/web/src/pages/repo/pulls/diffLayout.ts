/**
 * Layout for the Files changed text diff (#252), as pure functions: the split
 * view's left/right pairing, and the unchanged lines hidden between hunks that
 * "expand" reveals.
 */
import type { DiffLine } from "../../../types";

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/**
 * Side-by-side rows for one hunk, GitHub's way: unchanged lines on both sides,
 * and each run of removals paired line by line with the additions after it.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "remove") removed.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") added.push(lines[i++]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return rows;
}

/** Unchanged lines a diff leaves out, in new-file line numbers, and how old numbers relate. */
export type Gap = {
  /** The hunk it sits above; `hunks.length` for the end of the file. */
  before: number;
  /** First and last hidden line, in the new file (inclusive). */
  from: number;
  to: number;
  /** oldLine = newLine - offset across the gap. */
  offset: number;
};

function bounds(lines: DiffLine[]) {
  const news = lines.map((l) => l.newLineNo).filter((n): n is number => n != null);
  const olds = lines.map((l) => l.oldLineNo).filter((n): n is number => n != null);
  return {
    newStart: news.length ? Math.min(...news) : null,
    newEnd: news.length ? Math.max(...news) : null,
    oldStart: olds.length ? Math.min(...olds) : null,
    oldEnd: olds.length ? Math.max(...olds) : null,
  };
}

/**
 * The hidden stretches around and between `hunks`, given the new file's line
 * count. A hunk with no new-side lines (pure deletion) is anchored by its
 * neighbours; gaps that would be empty are left out.
 */
export function hunkGaps(hunks: Array<{ lines: DiffLine[] }>, newLineCount: number): Gap[] {
  const gaps: Gap[] = [];
  let prevNewEnd = 0;
  let prevOldEnd = 0;
  hunks.forEach((h, i) => {
    const b = bounds(h.lines);
    const newStart = b.newStart ?? prevNewEnd + 1;
    const oldStart = b.oldStart ?? prevOldEnd + 1;
    if (newStart - 1 >= prevNewEnd + 1) {
      gaps.push({ before: i, from: prevNewEnd + 1, to: newStart - 1, offset: newStart - oldStart });
    }
    prevNewEnd = b.newEnd ?? newStart - 1;
    prevOldEnd = b.oldEnd ?? oldStart - 1;
  });
  if (newLineCount > prevNewEnd) {
    gaps.push({ before: hunks.length, from: prevNewEnd + 1, to: newLineCount, offset: prevNewEnd - prevOldEnd });
  }
  return gaps;
}

/** Context lines for new-file lines `from`..`to` of `fileLines` (1-based), numbered on both sides. */
export function contextLines(fileLines: string[], from: number, to: number, offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  for (let n = from; n <= to && n <= fileLines.length; n++) {
    out.push({ type: "context", content: fileLines[n - 1], oldLineNo: n - offset, newLineNo: n });
  }
  return out;
}
