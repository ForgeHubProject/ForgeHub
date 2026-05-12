/** Line-level diff via LCS backtrack ( fine for typical README-sized files ). */

export type TextDiffLine = {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type PlainTextCompareResult = {
  kind: "plain-text";
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: { added: number; removed: number; unchanged: number };
  lines: TextDiffLine[];
};

function splitLines(s: string): string[] {
  if (s === "") return [];
  const raw = s.split(/\r?\n/);
  if (s.endsWith("\n") || s.endsWith("\r\n")) raw.pop();
  return raw;
}

/**
 * Longest-common-subsequence on lines → minimal add/remove hunks with unchanged runs.
 */
function diffLines(oldLines: string[], newLines: string[]): TextDiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? 1 + dp[i + 1][j + 1]
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNum = 1;
  let newNum = 1;

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({
        type: "unchanged",
        content: oldLines[i],
        oldLine: oldNum,
        newLine: newNum,
      });
      i++;
      j++;
      oldNum++;
      newNum++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({
        type: "removed",
        content: oldLines[i],
        oldLine: oldNum,
        newLine: null,
      });
      i++;
      oldNum++;
    } else {
      out.push({
        type: "added",
        content: newLines[j],
        oldLine: null,
        newLine: newNum,
      });
      j++;
      newNum++;
    }
  }

  while (i < n) {
    out.push({
      type: "removed",
      content: oldLines[i],
      oldLine: oldNum,
      newLine: null,
    });
    i++;
    oldNum++;
  }

  while (j < m) {
    out.push({
      type: "added",
      content: newLines[j],
      oldLine: null,
      newLine: newNum,
    });
    j++;
    newNum++;
  }

  return out;
}

export function comparePlainTextSnapshots(
  baseSnapshotId: string,
  targetSnapshotId: string,
  baseBody: string,
  targetBody: string,
): PlainTextCompareResult {
  const a = splitLines(baseBody);
  const b = splitLines(targetBody);
  const lines = diffLines(a, b);

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const row of lines) {
    if (row.type === "added") added++;
    else if (row.type === "removed") removed++;
    else unchanged++;
  }

  return {
    kind: "plain-text",
    baseSnapshotId,
    targetSnapshotId,
    summary: { added, removed, unchanged },
    lines,
  };
}
