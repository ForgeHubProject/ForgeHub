/** Line-level merge hunks derived from a 2-way plain-text diff (base → incoming). */

export type TextDiffLine = {
  type: "added" | "removed" | "unchanged";
  content: string;
};

export type TextMergeHunk = {
  id: string;
  /** Lines only on base (current / toBranch). */
  baseLines: string[];
  /** Lines only on incoming (fromBranch). */
  incomingLines: string[];
};

export function groupPlainTextHunks(lines: TextDiffLine[]): TextMergeHunk[] {
  const hunks: TextMergeHunk[] = [];
  let i = 0;
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
      else if (row.type === "added") incomingLines.push(row.content);
      i++;
    }
    if (baseLines.length > 0 || incomingLines.length > 0) {
      hunks.push({ id: `h${hunks.length}`, baseLines, incomingLines });
    }
  }
  return hunks;
}

export type TextHunkSide = "base" | "incoming";

/** Build merged file text from diff lines and per-hunk side picks (default: incoming). */
export function materializePlainTextMerge(
  lines: TextDiffLine[],
  hunkSides: Record<string, TextHunkSide>,
  defaultSide: TextHunkSide = "incoming",
): string {
  const hunks = groupPlainTextHunks(lines);
  let hunkIndex = 0;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const row = lines[i]!;
    if (row.type === "unchanged") {
      out.push(row.content);
      i++;
      continue;
    }
    const hunk = hunks[hunkIndex]!;
    const side = hunkSides[hunk.id] ?? defaultSide;
    if (side === "base") out.push(...hunk.baseLines);
    else out.push(...hunk.incomingLines);
    while (i < lines.length && lines[i]!.type !== "unchanged") i++;
    hunkIndex++;
  }
  return out.join("\n");
}
