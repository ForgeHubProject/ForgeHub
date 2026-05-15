import type { MergeSide } from "../api";
import type { TextDiffLineRow } from "../types";

export type PlainTextHunk = {
  id: string;
  baseLines: string[];
  incomingLines: string[];
};

/** Adjacent non-unchanged diff rows form one merge hunk (removed → base, added → incoming). */
export function groupPlainTextHunks(lines: TextDiffLineRow[]): PlainTextHunk[] {
  const hunks: PlainTextHunk[] = [];
  let i = 0;
  let hunkIndex = 0;

  while (i < lines.length) {
    if (lines[i]!.type === "unchanged") {
      i++;
      continue;
    }

    const baseLines: string[] = [];
    const incomingLines: string[] = [];
    while (i < lines.length && lines[i]!.type !== "unchanged") {
      const row = lines[i]!;
      if (row.type === "removed") baseLines.push(row.content);
      if (row.type === "added") incomingLines.push(row.content);
      i++;
    }

    if (baseLines.length > 0 || incomingLines.length > 0) {
      hunkIndex += 1;
      hunks.push({ id: `h${hunkIndex}`, baseLines, incomingLines });
    }
  }

  return hunks;
}

export function defaultHunkSides(
  hunks: PlainTextHunk[],
  side: MergeSide,
): Record<string, MergeSide> {
  const out: Record<string, MergeSide> = {};
  for (const h of hunks) out[h.id] = side;
  return out;
}

/** Build merged file text from per-hunk base/incoming picks. */
export function materializePlainTextMerge(
  lines: TextDiffLineRow[],
  sides: Record<string, MergeSide>,
): string {
  const hunks = groupPlainTextHunks(lines);
  const out: string[] = [];
  let hunkIdx = 0;
  let i = 0;

  while (i < lines.length) {
    const row = lines[i]!;
    if (row.type === "unchanged") {
      out.push(row.content);
      i++;
      continue;
    }

    const hunk = hunks[hunkIdx];
    hunkIdx += 1;
    if (!hunk) break;

    const side = sides[hunk.id] ?? "incoming";
    if (side === "base") out.push(...hunk.baseLines);
    else out.push(...hunk.incomingLines);

    while (i < lines.length && lines[i]!.type !== "unchanged") i++;
  }

  return out.join("\n");
}
