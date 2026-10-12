// The facts a file header states (#225), GitHub's way: "21 lines (17 loc) ·
// 520 Bytes" for text, and the size for every file.

/** A byte count as GitHub writes it: "520 Bytes", "1.2 KB", "3.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? "Byte" : "Bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/**
 * Lines and lines of code of a text file: every line, and the ones that aren't
 * blank. A final newline doesn't start another line.
 */
export function lineStats(content: string): { lines: number; loc: number } {
  if (content === "") return { lines: 0, loc: 0 };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { lines: lines.length, loc: lines.filter((l) => l.trim() !== "").length };
}
