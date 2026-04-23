import Fastify from "fastify";
import cors from "@fastify/cors";
import type { CanonicalArtifactDocument, CompareRequest } from "@forgehub/contracts";
import { compareCanonicalArtifacts } from "@forgehub/diff-core";
import {
  sampleBaseDoc,
  sampleBaseSnapshotId,
  sampleProjectId,
  sampleTargetDoc,
  sampleTargetSnapshotId
} from "./sample-data.js";

interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
}

interface SnapshotRecord {
  id: string;
  projectId: string;
  message: string;
  author: string;
  createdAt: string;
  document: CanonicalArtifactDocument;
}

interface CreateProjectBody {
  id?: string;
  name: string;
}

interface CreateSnapshotBody {
  id?: string;
  message: string;
  author: string;
  document: CanonicalArtifactDocument;
}

const projects = new Map<string, ProjectRecord>();
const snapshotsByProjectId = new Map<string, SnapshotRecord[]>();

function snapshotIdFromNow(): string {
  return `snap_${Date.now()}`;
}

function projectIdFromName(name: string): string {
  return `proj_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function requireProject(projectId: string) {
  const project = projects.get(projectId);
  if (!project) return null;
  return project;
}

function requireSnapshot(projectId: string, snapshotId: string) {
  const snapshots = snapshotsByProjectId.get(projectId) ?? [];
  return snapshots.find((item) => item.id === snapshotId) ?? null;
}

function seedSampleData(): void {
  const createdAt = new Date().toISOString();
  projects.set(sampleProjectId, {
    id: sampleProjectId,
    name: "Sample Computer Project",
    createdAt
  });
  snapshotsByProjectId.set(sampleProjectId, [
    {
      id: sampleBaseSnapshotId,
      projectId: sampleProjectId,
      message: "Base snapshot",
      author: "seed",
      createdAt,
      document: sampleBaseDoc
    },
    {
      id: sampleTargetSnapshotId,
      projectId: sampleProjectId,
      message: "Target snapshot",
      author: "seed",
      createdAt,
      document: sampleTargetDoc
    }
  ]);
}

seedSampleData();

async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/projects", async () => ({
    projects: [...projects.values()]
  }));

  app.post<{ Body: CreateProjectBody }>("/projects", async (request, reply) => {
    const body = request.body;
    if (!body?.name || !body.name.trim()) {
      return reply.code(400).send({
        error: {
          code: "INVALID_PROJECT_NAME",
          message: "name is required."
        }
      });
    }

    const id = body.id?.trim() || projectIdFromName(body.name);
    if (projects.has(id)) {
      return reply.code(409).send({
        error: {
          code: "PROJECT_ALREADY_EXISTS",
          message: `Project ${id} already exists.`
        }
      });
    }

    const project: ProjectRecord = {
      id,
      name: body.name.trim(),
      createdAt: new Date().toISOString()
    };
    projects.set(id, project);
    snapshotsByProjectId.set(id, []);
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>("/projects/:id/snapshots", async (request, reply) => {
    const project = requireProject(request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: `Project ${request.params.id} not found.`
        }
      });
    }

    const snapshots = (snapshotsByProjectId.get(project.id) ?? []).map((snapshot) => ({
      id: snapshot.id,
      message: snapshot.message,
      author: snapshot.author,
      createdAt: snapshot.createdAt
    }));

    return {
      projectId: project.id,
      projectName: project.name,
      snapshots
    };
  });

  app.get<{ Params: { id: string; snapshotId: string } }>(
    "/projects/:id/snapshots/:snapshotId",
    async (request, reply) => {
      const project = requireProject(request.params.id);
      if (!project) {
        return reply.code(404).send({
          error: {
            code: "PROJECT_NOT_FOUND",
            message: `Project ${request.params.id} not found.`
          }
        });
      }
      const snapshot = requireSnapshot(project.id, request.params.snapshotId);
      if (!snapshot) {
        return reply.code(404).send({
          error: {
            code: "SNAPSHOT_NOT_FOUND",
            message: `Snapshot ${request.params.snapshotId} not found in project ${project.id}.`
          }
        });
      }
      return {
        id: snapshot.id,
        projectId: snapshot.projectId,
        message: snapshot.message,
        author: snapshot.author,
        createdAt: snapshot.createdAt,
        document: snapshot.document
      };
    }
  );

  app.post<{ Params: { id: string }; Body: CreateSnapshotBody }>(
    "/projects/:id/snapshots",
    async (request, reply) => {
      const project = requireProject(request.params.id);
      if (!project) {
        return reply.code(404).send({
          error: {
            code: "PROJECT_NOT_FOUND",
            message: `Project ${request.params.id} not found.`
          }
        });
      }

      const body = request.body;
      if (!body?.author || !body?.message || !body?.document) {
        return reply.code(400).send({
          error: {
            code: "INVALID_SNAPSHOT_BODY",
            message: "author, message, and document are required."
          }
        });
      }

      if (body.document.projectId !== project.id) {
        return reply.code(400).send({
          error: {
            code: "PROJECT_MISMATCH",
            message: "document.projectId must match route project id."
          }
        });
      }

      const id = body.id?.trim() || snapshotIdFromNow();
      const snapshots = snapshotsByProjectId.get(project.id) ?? [];
      if (snapshots.some((item) => item.id === id)) {
        return reply.code(409).send({
          error: {
            code: "SNAPSHOT_ALREADY_EXISTS",
            message: `Snapshot ${id} already exists in project ${project.id}.`
          }
        });
      }

      const snapshot: SnapshotRecord = {
        id,
        projectId: project.id,
        message: body.message,
        author: body.author,
        createdAt: new Date().toISOString(),
        document: body.document
      };
      snapshots.push(snapshot);
      snapshotsByProjectId.set(project.id, snapshots);

      return reply.code(201).send({
        id: snapshot.id,
        projectId: snapshot.projectId,
        message: snapshot.message,
        author: snapshot.author,
        createdAt: snapshot.createdAt
      });
    }
  );

  app.post<{ Body: CompareRequest }>("/diffs/compare", async (request, reply) => {
    const { projectId, baseSnapshotId, targetSnapshotId, options } = request.body as CompareRequest;
    const project = requireProject(projectId);
    if (!project) {
      return reply.code(404).send({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: `Project ${projectId} not found.`
        }
      });
    }
    const baseSnapshot = requireSnapshot(projectId, baseSnapshotId);
    const targetSnapshot = requireSnapshot(projectId, targetSnapshotId);
    if (!baseSnapshot || !targetSnapshot) {
      return reply.code(404).send({
        error: {
          code: "SNAPSHOT_NOT_FOUND",
          message: `Snapshot pair ${baseSnapshotId} -> ${targetSnapshotId} was not found in project ${projectId}.`
        }
      });
    }

    return compareCanonicalArtifacts({
      projectId,
      baseSnapshotId,
      targetSnapshotId,
      baseDoc: baseSnapshot.document,
      targetDoc: targetSnapshot.document,
      includeRawJsonDiff: options?.includeRawJsonDiff ?? false,
      includeIgnoredStats: options?.includeIgnoredStats ?? true
    });
  });

  return app;
}

const port = Number(process.env.PORT ?? 3001);

buildServer()
  .then((app) =>
    app.listen({ port, host: "0.0.0.0" }).then(() => {
      app.log.info(`ForgeHub API listening on port ${port}`);
    })
  )
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
