import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { parseGltf, type GltfDocument } from "../gltf-parser.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

const gltfNodeSchema = z.object({
  name: z.string().optional(),
  children: z.array(z.number()).optional(),
  mesh: z.number().optional(),
  translation: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
}).passthrough();

const gltfSchema = z
  .object({
    asset: z.object({ version: z.string() }),
    scene: z.number().optional(),
    scenes: z
      .array(z.object({ nodes: z.array(z.number()).optional(), name: z.string().optional() }).passthrough())
      .optional(),
    nodes: z.array(gltfNodeSchema).optional(),
  })
  .passthrough();

const ingestBodySchema = z.object({
  gltf: gltfSchema,
  label: z.string().max(200).optional(),
  sourceFile: z.string().max(255).optional(),
});

function formatEntity(e: {
  id: string; entityId: string; parentEntityId: string | null; kind: string;
  name: string; path: string; posX: number | null; posY: number | null; posZ: number | null;
  rotX: number | null; rotY: number | null; rotZ: number | null;
  scaleX: number | null; scaleY: number | null; scaleZ: number | null;
  attributes: string; renderRef: string | null;
}) {
  return {
    id: e.id,
    entityId: e.entityId,
    parentEntityId: e.parentEntityId,
    kind: e.kind,
    name: e.name,
    path: e.path,
    transform: e.posX !== null
      ? {
          position: [e.posX, e.posY, e.posZ] as [number, number, number],
          rotationEulerDeg: [e.rotX, e.rotY, e.rotZ] as [number, number, number],
          scale: [e.scaleX, e.scaleY, e.scaleZ] as [number, number, number],
        }
      : null,
    attributes: JSON.parse(e.attributes || "{}") as Record<string, unknown>,
    renderRef: e.renderRef ? (JSON.parse(e.renderRef) as unknown) : null,
  };
}

function formatConstraint(c: {
  id: string; entityAId: string; entityBId: string;
  positionFixed: boolean; rotationFixed: boolean; createdAt: Date;
}) {
  return {
    id: c.id,
    entityAId: c.entityAId,
    entityBId: c.entityBId,
    positionFixed: c.positionFixed,
    rotationFixed: c.rotationFixed,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function snapshotRoutes(app: FastifyInstance) {
  // POST /repos/:handle/:name/snapshots — ingest a glTF
  app.post(
    "/repos/:handle/:name/snapshots",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

      const parsed = ingestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { gltf, label, sourceFile } = parsed.data;

      let entities;
      try {
        entities = parseGltf(gltf as GltfDocument);
      } catch (e) {
        return reply.status(422).send({ error: "Could not parse glTF scene graph", details: String(e) });
      }

      const snapshot = await prisma.snapshot.create({
        data: {
          repoId: repo.id,
          label: label?.trim() || null,
          sourceFile: sourceFile?.trim() || "upload.gltf",
          entities: {
            create: entities.map((e) => ({
              entityId: e.entityId,
              parentEntityId: e.parentEntityId ?? null,
              kind: e.kind,
              name: e.name,
              path: e.path,
              posX: e.transform?.position[0] ?? null,
              posY: e.transform?.position[1] ?? null,
              posZ: e.transform?.position[2] ?? null,
              rotX: e.transform?.rotationEulerDeg[0] ?? null,
              rotY: e.transform?.rotationEulerDeg[1] ?? null,
              rotZ: e.transform?.rotationEulerDeg[2] ?? null,
              scaleX: e.transform?.scale[0] ?? null,
              scaleY: e.transform?.scale[1] ?? null,
              scaleZ: e.transform?.scale[2] ?? null,
              attributes: JSON.stringify(e.attributes),
              renderRef: e.renderRef ? JSON.stringify(e.renderRef) : null,
            })),
          },
        },
        include: { entities: { orderBy: { path: "asc" } }, constraints: true },
      });

      return reply.status(201).send({
        id: snapshot.id,
        repoId: snapshot.repoId,
        label: snapshot.label,
        sourceFile: snapshot.sourceFile,
        schemaVersion: snapshot.schemaVersion,
        createdAt: snapshot.createdAt.toISOString(),
        entities: snapshot.entities.map(formatEntity),
        constraints: snapshot.constraints.map(formatConstraint),
      });
    },
  );

  // GET /repos/:handle/:name/snapshots — list snapshots
  app.get(
    "/repos/:handle/:name/snapshots",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      const snapshots = await prisma.snapshot.findMany({
        where: { repoId: repo.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, label: true, sourceFile: true, schemaVersion: true, createdAt: true },
      });

      return {
        snapshots: snapshots.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
      };
    },
  );

  // GET /repos/:handle/:name/snapshots/:snapshotId — get snapshot with full entity tree + constraints
  app.get(
    "/repos/:handle/:name/snapshots/:snapshotId",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, snapshotId } = request.params as {
        handle: string; name: string; snapshotId: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      const snapshot = await prisma.snapshot.findFirst({
        where: { id: snapshotId, repoId: repo.id },
        include: {
          entities: { orderBy: { path: "asc" } },
          constraints: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!snapshot) return reply.status(404).send({ error: "Snapshot not found" });

      return {
        id: snapshot.id,
        repoId: snapshot.repoId,
        label: snapshot.label,
        sourceFile: snapshot.sourceFile,
        schemaVersion: snapshot.schemaVersion,
        createdAt: snapshot.createdAt.toISOString(),
        entities: snapshot.entities.map(formatEntity),
        constraints: snapshot.constraints.map(formatConstraint),
      };
    },
  );

  // DELETE /repos/:handle/:name/snapshots/:snapshotId — delete a snapshot
  app.delete(
    "/repos/:handle/:name/snapshots/:snapshotId",
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

      await prisma.snapshot.delete({ where: { id: snapshotId } });
      return reply.status(204).send();
    },
  );
}
