import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { compareGltfSceneSnapshots, GLTF_SCENE_HANDLER_ID } from "../handlers/index.js";
import { canRead, resolveRepo } from "../repo-access.js";

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
          include: { entities: { orderBy: { path: "asc" } } },
        }),
        prisma.snapshot.findFirst({
          where: { id: target, repoId: repo.id },
          include: { entities: { orderBy: { path: "asc" } } },
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

      if (baseSnap.handlerId === GLTF_SCENE_HANDLER_ID) {
        return compareGltfSceneSnapshots(base, target, baseSnap.entities, targetSnap.entities);
      }

      return reply.status(501).send({
        error: "Compare is not implemented for this handler",
        handlerId: baseSnap.handlerId,
      });
    },
  );
}
