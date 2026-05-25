import { prisma } from "../../prisma.js";
import type { ArtifactHandler, IngestInput, StructuredDiff, DiffChange } from "../types.js";
import { PLAIN_TEXT_HANDLER_ID } from "../types.js";

/** Skip binaries / huge payloads */
export const PLAIN_TEXT_MAX_BYTES = 512 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|log|csv|json|ya?ml|toml|ini)$/i;

function matchesPlainTextPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/^(Dockerfile|LICENSE|Makefile|README)$/i.test(base)) return true;
  if (base === ".gitignore" || base === ".env" || /^\.env\./i.test(base)) return true;
  return TEXT_EXT.test(path);
}

async function ingestPlainUtf8(input: IngestInput): Promise<string> {
  const { repoId, sourceFile, utf8Text, label, gitCommitSha } = input;

  const buf = Buffer.byteLength(utf8Text, "utf8");
  if (buf > PLAIN_TEXT_MAX_BYTES) {
    throw new Error(`Text exceeds ${PLAIN_TEXT_MAX_BYTES} bytes`);
  }

  if (gitCommitSha) {
    const existing = await prisma.snapshot.findFirst({
      where: { repoId, gitCommitSha, sourceFile },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const snapshot = await prisma.snapshot.create({
    data: {
      repoId,
      handlerId: PLAIN_TEXT_HANDLER_ID,
      label,
      sourceFile,
      gitCommitSha,
      snapshotBody: utf8Text,
      entities: { create: [] },
    },
    select: { id: true },
  });

  return snapshot.id;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const raw = s.split(/\r?\n/);
  if (s.endsWith("\n") || s.endsWith("\r\n")) raw.pop();
  return raw;
}

function diffTextLines(oldLines: string[], newLines: string[]): DiffChange[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? 1 + dp[i + 1][j + 1]
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const changes: DiffChange[] = [];
  let i = 0;
  let j = 0;
  let oldNum = 1;
  let newNum = 1;

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i++; j++; oldNum++; newNum++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      changes.push({ path: `line:${oldNum}`, kind: "removed", before: oldLines[i] });
      i++; oldNum++;
    } else {
      changes.push({ path: `line:${newNum}`, kind: "added", after: newLines[j] });
      j++; newNum++;
    }
  }
  while (i < n) {
    changes.push({ path: `line:${oldNum}`, kind: "removed", before: oldLines[i++] });
    oldNum++;
  }
  while (j < m) {
    changes.push({ path: `line:${newNum}`, kind: "added", after: newLines[j++] });
    newNum++;
  }

  return changes;
}

async function diffPlainText(base: Buffer, head: Buffer): Promise<StructuredDiff> {
  return {
    version: "1.0",
    format: "text",
    changes: diffTextLines(splitLines(base.toString("utf8")), splitLines(head.toString("utf8"))),
  };
}

export const plainTextHandler: ArtifactHandler = {
  id: PLAIN_TEXT_HANDLER_ID,
  capabilities: { semanticCompare: true, semanticMerge: false },
  matchesPath: matchesPlainTextPath,
  ingestFromUtf8Text: ingestPlainUtf8,
  diff: diffPlainText,
};
