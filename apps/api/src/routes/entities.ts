import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

async function collectSubtreeIds(snapshotId: string, rootDbId: string): Promise<string[]> {
  const ids: string[] = [];
  const queue = [rootDbId];

  while (queue.length > 0) {
    const dbId = queue.shift()!;
    ids.push(dbId);

    const entity = await prisma.entity.findUnique({ where: { id: dbId }, select: { entityId: true } });
    if (!entity) continue;

    const children = await prisma.entity.findMany({
      where: { snapshotId, parentEntityId: entity.entityId },
      select: { id: true },
    });
    queue.push(...children.map((c) => c.id));
  }

  return ids;
}

export async function entityRoutes(app: FastifyInstance) {
  app.delete(
    "/repos/:handle/:name/snapshots/:snapshotId/entities/:entityId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId, entityId } = request.params as {
        handle: string; name: string; snapshotId: string; entityId: string;
      };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

      const snapshot = await prisma.snapshot.findFirst({ where: { id: snapshotId, repoId: repo.id } });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });

      const entity = await prisma.entity.findFirst({ where: { id: entityId, snapshotId } });
      if (!entity) return reply.status(404).send({ error: "Entity not found" });

      // Root entity → delete the entire snapshot
      if (!entity.parentEntityId) {
        await prisma.snapshot.delete({ where: { id: snapshotId } });
        return reply.status(200).send({ snapshotDeleted: true, snapshotId });
      }

      // Collect the full subtree
      const subtreeIds = await collectSubtreeIds(snapshotId, entityId);

      // Count constraints that will be removed (for response info)
      const deletedConstraints = await prisma.constraint.count({
        where: {
          snapshotId,
          OR: [
            { entityAId: { in: subtreeIds } },
            { entityBId: { in: subtreeIds } },
          ],
        },
      });

      // Delete constraints first (explicit, avoids FK ordering issues)
      await prisma.constraint.deleteMany({
        where: {
          snapshotId,
          OR: [
            { entityAId: { in: subtreeIds } },
            { entityBId: { in: subtreeIds } },
          ],
        },
      });

      // Delete the entities
      await prisma.entity.deleteMany({ where: { id: { in: subtreeIds } } });

      return reply.status(200).send({
        snapshotDeleted: false,
        deletedEntities: subtreeIds.length,
        deletedConstraints,
      });
    },
  );
}
