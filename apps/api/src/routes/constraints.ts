import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { GLTF_SCENE_HANDLER_ID } from "../handlers/index.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

const createConstraintBodySchema = z.object({
  entityAId: z.string().min(1),
  entityBId: z.string().min(1),
  positionFixed: z.boolean().default(true),
  rotationFixed: z.boolean().default(true),
});

function formatConstraint(c: {
  id: string; snapshotId: string; entityAId: string; entityBId: string;
  positionFixed: boolean; rotationFixed: boolean; createdAt: Date;
}) {
  return {
    id: c.id,
    snapshotId: c.snapshotId,
    entityAId: c.entityAId,
    entityBId: c.entityBId,
    positionFixed: c.positionFixed,
    rotationFixed: c.rotationFixed,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function constraintRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/snapshots/:snapshotId/constraints
  app.get(
    "/repos/:handle/:name/snapshots/:snapshotId/constraints",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId } = request.params as {
        handle: string; name: string; snapshotId: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      const snapshot = await prisma.snapshot.findFirst({ where: { id: snapshotId, repoId: repo.id } });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Constraints apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

      const constraints = await prisma.constraint.findMany({
        where: { snapshotId },
        orderBy: { createdAt: "asc" },
      });

      return { constraints: constraints.map(formatConstraint) };
    },
  );

  // POST /repos/:handle/:name/snapshots/:snapshotId/constraints — fix two entities
  app.post(
    "/repos/:handle/:name/snapshots/:snapshotId/constraints",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId } = request.params as {
        handle: string; name: string; snapshotId: string;
      };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

      const snapshot = await prisma.snapshot.findFirst({ where: { id: snapshotId, repoId: repo.id } });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Constraints apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

      const parsed = createConstraintBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { entityAId, entityBId, positionFixed, rotationFixed } = parsed.data;

      if (entityAId === entityBId) {
        return reply.status(400).send({ error: "Cannot constrain an entity to itself" });
      }

      // Verify both entities belong to this snapshot
      const [entityA, entityB] = await Promise.all([
        prisma.entity.findFirst({ where: { id: entityAId, snapshotId } }),
        prisma.entity.findFirst({ where: { id: entityBId, snapshotId } }),
      ]);
      if (!entityA) return reply.status(404).send({ error: "Entity A not found in this snapshot" });
      if (!entityB) return reply.status(404).send({ error: "Entity B not found in this snapshot" });

      // Prevent duplicate in either direction
      const existing = await prisma.constraint.findFirst({
        where: {
          snapshotId,
          OR: [
            { entityAId, entityBId },
            { entityAId: entityBId, entityBId: entityAId },
          ],
        },
      });
      if (existing) {
        return reply.status(409).send({ error: "A constraint already exists between these entities" });
      }

      const constraint = await prisma.constraint.create({
        data: { snapshotId, entityAId, entityBId, positionFixed, rotationFixed },
      });

      return reply.status(201).send(formatConstraint(constraint));
    },
  );

  // PATCH /repos/:handle/:name/snapshots/:snapshotId/constraints/:constraintId — update flags
  app.patch(
    "/repos/:handle/:name/snapshots/:snapshotId/constraints/:constraintId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId, constraintId } = request.params as {
        handle: string; name: string; snapshotId: string; constraintId: string;
      };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

      const snapshot = await prisma.snapshot.findFirst({ where: { id: snapshotId, repoId: repo.id } });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Constraints apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

      const updateSchema = z.object({
        positionFixed: z.boolean().optional(),
        rotationFixed: z.boolean().optional(),
      });
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const existing = await prisma.constraint.findFirst({
        where: { id: constraintId, snapshotId },
      });
      if (!existing) return reply.status(404).send({ error: "Constraint not found" });

      const updated = await prisma.constraint.update({
        where: { id: constraintId },
        data: parsed.data,
      });

      return formatConstraint(updated);
    },
  );

  // DELETE /repos/:handle/:name/snapshots/:snapshotId/constraints/:constraintId — unfix
  app.delete(
    "/repos/:handle/:name/snapshots/:snapshotId/constraints/:constraintId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId, constraintId } = request.params as {
        handle: string; name: string; snapshotId: string; constraintId: string;
      };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

      const snapshot = await prisma.snapshot.findFirst({ where: { id: snapshotId, repoId: repo.id } });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });
      if (snapshot.handlerId !== GLTF_SCENE_HANDLER_ID) {
        return reply.status(400).send({
          error: "Constraints apply only to glTF scene snapshots",
          handlerId: snapshot.handlerId,
        });
      }

      const existing = await prisma.constraint.findFirst({
        where: { id: constraintId, snapshotId },
      });
      if (!existing) return reply.status(404).send({ error: "Constraint not found" });

      await prisma.constraint.delete({ where: { id: constraintId } });
      return reply.status(204).send();
    },
  );
}
