import type { TextDiffLineRow } from "../types";

export function plainTextDiffHasOld(lines: TextDiffLineRow[]): boolean {
  return lines.some((row) => row.type === "removed" || row.type === "unchanged");
}

export function plainTextDiffHasNew(lines: TextDiffLineRow[]): boolean {
  return lines.some((row) => row.type === "added" || row.type === "unchanged");
}

/** Reconstruct base-side file text from a line diff. */
export function plainTextFromBase(lines: TextDiffLineRow[]): string {
  const out: string[] = [];
  for (const row of lines) {
    if (row.type === "removed" || row.type === "unchanged") out.push(row.content);
  }
  return out.join("\n");
}

/** Reconstruct target-side file text from a line diff. */
export function plainTextFromTarget(lines: TextDiffLineRow[]): string {
  const out: string[] = [];
  for (const row of lines) {
    if (row.type === "added" || row.type === "unchanged") out.push(row.content);
  }
  return out.join("\n");
}
