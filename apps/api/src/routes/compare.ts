import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import {
  firstHandlerForPath,
  compareGltfSceneSnapshots,
  comparePlainTextSnapshots,
  GLTF_SCENE_HANDLER_ID,
  PLAIN_TEXT_HANDLER_ID,
} from "../handlers/index.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { resolveBlobSha, readBlobAsBuffer } from "../git-utils.js";

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

      // Lean select — no entity rows needed for the fast path
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

      const handler = firstHandlerForPath(baseSnap.sourceFile);
      const storageKey = repo.storageKey;

      // ── Forge path: blob-level diff with cache ────────────────────────────
      if (handler && storageKey && baseSnap.gitCommitSha && targetSnap.gitCommitSha) {
        const [baseBlobSha, headBlobSha] = await Promise.all([
          resolveBlobSha(storageKey, baseSnap.gitCommitSha, baseSnap.sourceFile),
          resolveBlobSha(storageKey, targetSnap.gitCommitSha, targetSnap.sourceFile),
        ]);

        if (baseBlobSha && headBlobSha) {
          const cached = await prisma.diffCache.findUnique({
            where: { handlerId_baseBlobSha_headBlobSha: { handlerId: handler.id, baseBlobSha, headBlobSha } },
          });
          if (cached) return JSON.parse(cached.result);

          const [baseBuffer, headBuffer] = await Promise.all([
            readBlobAsBuffer(storageKey, baseSnap.gitCommitSha, baseSnap.sourceFile),
            readBlobAsBuffer(storageKey, targetSnap.gitCommitSha, targetSnap.sourceFile),
          ]);

          if (baseBuffer && headBuffer) {
            const diff = await handler.diff(baseBuffer, headBuffer);
            // Cache write is non-fatal — don't await
            prisma.diffCache.create({
              data: { handlerId: handler.id, baseBlobSha, headBlobSha, result: JSON.stringify(diff) },
            }).catch(() => undefined);
            return diff;
          }
        }
      }

      // ── Fallback: snapshot-based comparison (no commit SHA, or blob unresolvable) ──
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
        return compareGltfSceneSnapshots(base, target, baseSnapFull.entities, targetSnapFull.entities);
      }
      if (baseSnapFull.handlerId === PLAIN_TEXT_HANDLER_ID) {
        return comparePlainTextSnapshots(base, target, baseSnapFull.snapshotBody ?? "", targetSnapFull.snapshotBody ?? "");
      }

      return reply.status(501).send({
        error: "Compare is not implemented for this handler",
        handlerId: baseSnap.handlerId,
      });
    },
  );
}
