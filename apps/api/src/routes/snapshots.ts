import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { getHandler, GLTF_SCENE_HANDLER_ID, PLAIN_TEXT_HANDLER_ID } from "../handlers/index.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { branchShas } from "../git-utils.js";

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

const ingestBodySchema = z
  .object({
    handlerId: z.string().optional(),
    gltf: gltfSchema.optional(),
    text: z.string().optional(),
    label: z.string().max(200).optional(),
    sourceFile: z.string().max(255).optional(),
  })
  .superRefine((data, ctx) => {
    const hasGltf = data.gltf !== undefined;
    const hasText = data.text !== undefined;
    if (hasGltf === hasText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of gltf or text",
        path: [],
      });
    }
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
  // POST /repos/:handle/:name/snapshots — ingest payload via artifact handler
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

      const body = parsed.data;
      const inferredHandlerId =
        body.text !== undefined ? PLAIN_TEXT_HANDLER_ID : GLTF_SCENE_HANDLER_ID;
      const requestedHandlerId = body.handlerId ?? inferredHandlerId;
      const handler = getHandler(requestedHandlerId);
      if (!handler) {
        return reply.status(400).send({ error: "Unknown handlerId", handlerId: requestedHandlerId });
      }
      if (requestedHandlerId !== inferredHandlerId) {
        return reply.status(400).send({
          error: "handlerId does not match payload (gltf → gltf-scene, text → plain-text)",
          handlerId: requestedHandlerId,
          inferredHandlerId,
        });
      }

      const utf8Text =
        body.text !== undefined ? body.text : JSON.stringify(body.gltf);
      const defaultSource =
        inferredHandlerId === PLAIN_TEXT_HANDLER_ID ? "upload.txt" : "upload.gltf";

      let snapshotId: string;
      try {
        snapshotId = await handler.ingestFromUtf8Text({
          repoId: repo.id,
          sourceFile: body.sourceFile?.trim() || defaultSource,
          utf8Text,
          label: body.label?.trim() || null,
          gitCommitSha: null,
        });
      } catch (e) {
        return reply.status(422).send({ error: "Could not ingest artifact", details: String(e) });
      }

      const snapshot = await prisma.snapshot.findFirst({
        where: { id: snapshotId, repoId: repo.id },
        include: { entities: { orderBy: { path: "asc" } }, constraints: true },
      });
      if (!snapshot) {
        return reply.status(500).send({ error: "Snapshot created but not found" });
      }

      return reply.status(201).send({
        id: snapshot.id,
        repoId: snapshot.repoId,
        handlerId: snapshot.handlerId,
        label: snapshot.label,
        sourceFile: snapshot.sourceFile,
        schemaVersion: snapshot.schemaVersion,
        createdAt: snapshot.createdAt.toISOString(),
        gitCommitSha: snapshot.gitCommitSha ?? null,
        snapshotBody: snapshot.snapshotBody ?? null,
        entities: snapshot.entities.map(formatEntity),
        constraints: snapshot.constraints.map(formatConstraint),
      });
    },
  );

  // GET /repos/:handle/:name/snapshots — list snapshots (optional ?branch= filter)
  app.get(
    "/repos/:handle/:name/snapshots",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;
      const { branch } = request.query as { branch?: string };

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      let allowedShas: Set<string> | null = null;
      if (branch && repo.storageKey) {
        const shas = await branchShas(repo.storageKey, branch);
        allowedShas = new Set(shas);
      }

      const snapshots = await prisma.snapshot.findMany({
        where: { repoId: repo.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          handlerId: true,
          label: true,
          sourceFile: true,
          schemaVersion: true,
          createdAt: true,
          gitCommitSha: true,
        },
      });

      const filtered = allowedShas
        ? snapshots.filter((s) => s.gitCommitSha && allowedShas!.has(s.gitCommitSha))
        : snapshots;

      return {
        snapshots: filtered.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
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
        handlerId: snapshot.handlerId,
        label: snapshot.label,
        sourceFile: snapshot.sourceFile,
        schemaVersion: snapshot.schemaVersion,
        createdAt: snapshot.createdAt.toISOString(),
        gitCommitSha: snapshot.gitCommitSha ?? null,
        snapshotBody: snapshot.snapshotBody ?? null,
        entities: snapshot.entities.map(formatEntity),
        constraints: snapshot.constraints.map(formatConstraint),
      };
    },
  );

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
