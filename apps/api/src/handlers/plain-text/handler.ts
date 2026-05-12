import { prisma } from "../../prisma.js";
import type { ArtifactHandler, IngestInput } from "../types.js";
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

export const plainTextHandler: ArtifactHandler = {
  id: PLAIN_TEXT_HANDLER_ID,
  capabilities: { semanticCompare: true },
  matchesPath: matchesPlainTextPath,
  ingestFromUtf8Text: ingestPlainUtf8,
};
