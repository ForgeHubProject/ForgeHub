import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import {
  firstHandlerForPathAndFormats,
  GLTF_SCENE_HANDLER_ID,
  PLAIN_TEXT_HANDLER_ID,
} from "../handlers/index.js";
import type { StructuredDiff, DiffChange } from "../handlers/types.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { activeFormatsAtCommit, resolveBlobSha, readBlobAsBuffer } from "../git-utils.js";
import { compareGltfSceneSnapshots } from "../handlers/gltf-scene/compare.js";
import { comparePlainTextSnapshots } from "../handlers/plain-text/compare.js";

export async function compareRoutes(app: FastifyInstance) {
  app.get(
    "/repos/:handle/:name/compare",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { base, target } = request.query as { base?: string; target?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!base || !target) {
        return reply.status(400).send({ error: "Both 'base' and 'target' query params are required" });
      }
      if (base === target) {
        return reply.status(400).send({ error: "'base' and 'target' must be different snapshots" });
      }

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      const [baseSnap, targetSnap] = await Promise.all([
        prisma.snapshot.findFirst({
          where: { id: base, repoId: repo.id },
          select: { id: true, handlerId: true, gitCommitSha: true, sourceFile: true, snapshotBody: true },
        }),
        prisma.snapshot.findFirst({
          where: { id: target, repoId: repo.id },
          select: { id: true, handlerId: true, gitCommitSha: true, sourceFile: true, snapshotBody: true },
        }),
      ]);

      if (!baseSnap) return reply.status(404).send({ error: `Base snapshot '${base}' not found` });
      if (!targetSnap) return reply.status(404).send({ error: `Target snapshot '${target}' not found` });
      if (baseSnap.handlerId !== targetSnap.handlerId) {
        return reply.status(400).send({
          error: "Cross-handler compare is not supported",
          baseHandlerId: baseSnap.handlerId,
          targetHandlerId: targetSnap.handlerId,
        });
      }

      const storageKey = repo.storageKey;

      // Handler resolution is scoped to the repo's opt-in formats at the
      // target commit. If the format has since been disabled, the fast path
      // is skipped and the snapshot-based fallback below still serves the
      // already-ingested data.
      const handler =
        storageKey && targetSnap.gitCommitSha
          ? firstHandlerForPathAndFormats(
              baseSnap.sourceFile,
              await activeFormatsAtCommit(storageKey, targetSnap.gitCommitSha),
            )
          : undefined;

      // ── Fast path: blob-level diff with cache ─────────────────────────────────
      if (handler && storageKey && baseSnap.gitCommitSha && targetSnap.gitCommitSha) {
        const [baseBlobSha, headBlobSha] = await Promise.all([
          resolveBlobSha(storageKey, baseSnap.gitCommitSha, baseSnap.sourceFile),
          resolveBlobSha(storageKey, targetSnap.gitCommitSha, targetSnap.sourceFile),
        ]);

        if (baseBlobSha && headBlobSha) {
          const cached = await prisma.diffCache.findUnique({
            where: { handlerId_baseBlobSha_headBlobSha: { handlerId: handler.id, baseBlobSha, headBlobSha } },
          });

          const [baseBuffer, headBuffer] = await Promise.all([
            readBlobAsBuffer(storageKey, baseSnap.gitCommitSha, baseSnap.sourceFile),
            readBlobAsBuffer(storageKey, targetSnap.gitCommitSha, targetSnap.sourceFile),
          ]);

          if (baseBuffer && headBuffer) {
            let diff: StructuredDiff;
            if (cached) {
              diff = JSON.parse(cached.result) as StructuredDiff;
            } else {
              diff = await handler.diff(baseBuffer, headBuffer);
              prisma.diffCache.create({
                data: { handlerId: handler.id, baseBlobSha, headBlobSha, result: JSON.stringify(diff) },
              }).catch(() => undefined);
            }

            return buildNormalizedResponse(diff, base, target, baseSnap.snapshotBody, targetSnap.snapshotBody, baseBuffer, headBuffer);
          }
        }
      }

      // ── Fallback: snapshot-based comparison ───────────────────────────────────
      const [baseSnapFull, targetSnapFull] = await Promise.all([
        prisma.snapshot.findFirst({
          where: { id: base, repoId: repo.id },
          include: { entities: { orderBy: { path: "asc" } } },
        }),
        prisma.snapshot.findFirst({
          where: { id: target, repoId: repo.id },
          include: { entities: { orderBy: { path: "asc" } } },
        }),
      ]);

      if (!baseSnapFull || !targetSnapFull) {
        return reply.status(404).send({ error: "Snapshot not found" });
      }

      if (baseSnapFull.handlerId === GLTF_SCENE_HANDLER_ID) {
        const gltfResult = compareGltfSceneSnapshots(base, target, baseSnapFull.entities, targetSnapFull.entities);
        const changes: DiffChange[] = gltfResult.changes
          .filter((c) => c.type !== "unchanged")
          .map((c) => ({
            path: c.path,
            kind: (c.type === "added" ? "added" : c.type === "removed" ? "removed" : "modified") as "added" | "removed" | "modified",
            label: c.name,
            before: c.before ?? undefined,
            after: c.after ?? undefined,
            children: c.fieldChanges.map((fc) => ({
              path: fc.field,
              kind: "modified" as const,
              before: fc.before,
              after: fc.after,
            })),
          }));
        return { version: "1.0", format: "gltf-scene", baseSnapshotId: base, targetSnapshotId: target, changes };
      }

      if (baseSnapFull.handlerId === PLAIN_TEXT_HANDLER_ID) {
        const baseBody = baseSnapFull.snapshotBody ?? "";
        const targetBody = targetSnapFull.snapshotBody ?? "";
        return buildTextResponse(base, target, baseBody, targetBody);
      }

      return reply.status(501).send({
        error: "Compare is not implemented for this handler",
        handlerId: baseSnap.handlerId,
      });
    },
  );
}

function buildTextResponse(base: string, target: string, baseBody: string, targetBody: string) {
  const { lines } = comparePlainTextSnapshots(base, target, baseBody, targetBody);
  // Derive sparse changes (added/removed only) from lines for the StructuredDiff format
  const changes: DiffChange[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const l of lines) {
    if (l.type === "added") {
      changes.push({ path: `line:${newNum}`, kind: "added", after: l.content });
      newNum++;
    } else if (l.type === "removed") {
      changes.push({ path: `line:${oldNum}`, kind: "removed", before: l.content });
      oldNum++;
    } else {
      oldNum++;
      newNum++;
    }
  }
  return { version: "1.0" as const, format: "text", baseSnapshotId: base, targetSnapshotId: target, changes, lines };
}

function buildNormalizedResponse(
  diff: StructuredDiff,
  base: string,
  target: string,
  baseBody: string | null,
  targetBody: string | null,
  baseBuffer?: Buffer,
  headBuffer?: Buffer,
) {
  if (diff.format === "text") {
    const b = baseBody ?? baseBuffer?.toString("utf8") ?? "";
    const h = targetBody ?? headBuffer?.toString("utf8") ?? "";
    return buildTextResponse(base, target, b, h);
  }
  return { ...diff, baseSnapshotId: base, targetSnapshotId: target };
}
