import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { GLTF_SCENE_HANDLER_ID } from "../handlers/index.js";
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

async function collectPositionFixedGroup(snapshotId: string, seedEntityId: string): Promise<string[]> {
  const constraints = await prisma.constraint.findMany({
    where: { snapshotId, positionFixed: true },
    select: { entityAId: true, entityBId: true },
  });

  const adjacency = new Map<string, Set<string>>();
  for (const c of constraints) {
    const aSet = adjacency.get(c.entityAId) ?? new Set<string>();
    aSet.add(c.entityBId);
    adjacency.set(c.entityAId, aSet);

    const bSet = adjacency.get(c.entityBId) ?? new Set<string>();
    bSet.add(c.entityAId);
    adjacency.set(c.entityBId, bSet);
  }

  const visited = new Set<string>([seedEntityId]);
  const queue = [seedEntityId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return [...visited];
}

export async function entityRoutes(app: FastifyInstance) {
  app.patch(
    "/repos/:handle/:name/snapshots/:snapshotId/entities/:entityId/position",
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
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Entity transforms apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

      const entity = await prisma.entity.findFirst({ where: { id: entityId, snapshotId } });
      if (!entity) return reply.status(404).send({ error: "Entity not found" });

      const bodySchema = z.object({
        delta: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
      });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const [dx, dy, dz] = parsed.data.delta;
      if (dx === 0 && dy === 0 && dz === 0) {
        return reply.send({ movedEntityIds: [entityId], delta: [dx, dy, dz] as [number, number, number] });
      }

      const targetIds = await collectPositionFixedGroup(snapshotId, entityId);
      const targetEntities = await prisma.entity.findMany({
        where: { id: { in: targetIds }, snapshotId },
        select: { id: true, posX: true, posY: true, posZ: true },
      });

      await prisma.$transaction(
        targetEntities.map((e) =>
          prisma.entity.update({
            where: { id: e.id },
            data: {
              posX: (e.posX ?? 0) + dx,
              posY: (e.posY ?? 0) + dy,
              posZ: (e.posZ ?? 0) + dz,
            },
          }),
        ),
      );

      return reply.send({
        movedEntityIds: targetEntities.map((e) => e.id),
        delta: [dx, dy, dz] as [number, number, number],
      });
    },
  );

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
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Entity edits apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

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
