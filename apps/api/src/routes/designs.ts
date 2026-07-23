import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import {
  buildDesignStorageKey, writeDesignStream, readDesignStream, readDesignBuffer, removeDesign,
} from "../git-storage.js";
import { designHandlerFor, isImageName, ingestDesignSnapshot, gitBlobSha } from "../design-ingest.js";
import { sanitizeAssetName } from "./releases.js";
import { recordEvent } from "../timeline-service.js";
import type { StructuredDiff, DiffChange } from "../handlers/types.js";

// Default design upload cap mirrors the release-asset default (100 MiB). The
// multipart plugin is registered once with the release cap; each design upload
// applies its own cap per-call so the two limits stay independent.
function designMaxBytes(): number {
  return Number(process.env["DESIGN_MAX_BYTES"] ?? 100 * 1024 * 1024);
}

type VersionRecord = {
  version: number;
  contentType: string;
  size: number;
  snapshotId: string | null;
  storageKey: string;
  uploadedBy?: { handle: string } | null;
  createdAt: Date;
};

type DesignRecord = {
  id: string;
  name: string;
  currentVersion: number;
  createdBy?: { handle: string } | null;
  createdAt: Date;
  versions?: VersionRecord[];
};

function formatVersion(name: string, v: VersionRecord) {
  return {
    version: v.version,
    contentType: v.contentType,
    size: v.size,
    // Whether this version carries an ingested entity tree (semantic-diff capable).
    hasSnapshot: v.snapshotId !== null,
    // Whether this version renders inline as an image (visual-diff capable).
    isImage: isImageName(name, v.contentType),
    uploadedBy: v.uploadedBy?.handle ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

function formatDesign(d: DesignRecord) {
  const sorted = (d.versions ?? []).slice().sort((a, b) => a.version - b.version);
  return {
    id: d.id,
    name: d.name,
    currentVersion: d.currentVersion,
    // Whether the format supports FHR semantic diffing at all (by extension).
    semantic: designHandlerFor(d.name) !== undefined,
    isImage: isImageName(d.name),
    createdBy: d.createdBy?.handle ?? null,
    createdAt: d.createdAt.toISOString(),
    versions: sorted.map((v) => formatVersion(d.name, v)),
  };
}

const versionSelect = {
  version: true, contentType: true, size: true, snapshotId: true, storageKey: true,
  createdAt: true, uploadedBy: { select: { handle: true } },
} as const;

const designInclude = {
  createdBy: { select: { handle: true } },
  versions: { select: versionSelect, orderBy: { version: "asc" } },
} as const;

// A Content-Disposition value safe for arbitrary UTF-8 names. Images render
// inline (so <img> works); other types download.
function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function designRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to upload/delete (mirrors issue writes); a
  // session/JWT is unscoped and passes. Route bodies keep read + participation
  // checks on top, matching issue-comment permissions.
  const write = app.requireScope("repo:write");

  // GET .../issues/:number/designs — list designs with their version history.
  app.get(
    "/repos/:handle/:name/issues/:number/designs",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

      const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      const designs = await prisma.design.findMany({
        where: { issueId: issue.id },
        include: designInclude,
        orderBy: { createdAt: "asc" },
      });

      return { designs: designs.map(formatDesign) };
    },
  );

  // POST .../issues/:number/designs — upload a new design or a new version.
  // Same design name (the uploaded file name) → version bump. Gated like issue
  // comments: repo read + authenticated; a locked conversation restricts to writers.
  app.post(
    "/repos/:handle/:name/issues/:number/designs",
    { preHandler: [app.authenticate, write] },
    async (request, reply) => {
      const { handle, name, number } = request.params as { handle: string; name: string; number: string };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

      const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      if (issue.locked && !canWrite(repo, userId)) {
        return reply.status(403).send({ error: "This conversation is locked. Only collaborators with write access can add designs." });
      }

      let data;
      try {
        data = await request.file({ limits: { fileSize: designMaxBytes() }, throwFileSizeLimit: false });
      } catch {
        return reply.status(400).send({ error: "Invalid multipart upload" });
      }
      if (!data) return reply.status(400).send({ error: "A file is required" });

      const designName = sanitizeAssetName(data.filename);
      if (!designName) {
        data.file.resume();
        return reply.status(400).send({ error: "Invalid design file name" });
      }

      // New design or existing one (same name on this issue → new version).
      const existing = await prisma.design.findFirst({ where: { issueId: issue.id, name: designName } });
      const design = existing ?? await prisma.design.create({
        data: { issueId: issue.id, name: designName, currentVersion: 0, createdById: userId },
      });
      const version = design.currentVersion + 1;
      const storageKey = buildDesignStorageKey(repo.id, design.id, version);

      // Clean up a design row we created just for a failed first upload.
      const abortNewDesign = async () => {
        if (!existing) await prisma.design.delete({ where: { id: design.id } }).catch(() => {});
      };

      let size: number;
      try {
        size = await writeDesignStream(storageKey, data.file);
      } catch {
        await removeDesign(storageKey).catch(() => {});
        await abortNewDesign();
        return reply.status(500).send({ error: "Failed to store design" });
      }
      if (data.file.truncated) {
        await removeDesign(storageKey).catch(() => {});
        await abortNewDesign();
        return reply.status(413).send({ error: "File exceeds the maximum design size" });
      }

      // FHR-recognized formats get an entity tree via the shared ingest pipeline;
      // images/binaries store fine with a null snapshot.
      const buffer = await readDesignBuffer(storageKey);
      const snapshotId = await ingestDesignSnapshot({ repoId: repo.id, name: designName, buffer });

      let created;
      try {
        created = await prisma.designVersion.create({
          data: {
            designId: design.id,
            version,
            storageKey,
            contentType: data.mimetype || "application/octet-stream",
            size,
            snapshotId,
            uploadedById: userId,
          },
        });
      } catch {
        await removeDesign(storageKey).catch(() => {});
        return reply.status(409).send({ error: "A concurrent upload already created this version; retry." });
      }

      const updated = await prisma.design.update({
        where: { id: design.id },
        data: { currentVersion: version },
        include: designInclude,
      });

      // Timeline (#80): a new design vs. a new version of an existing one.
      await recordEvent({
        repoId: repo.id, subjectType: "ISSUE", subjectNumber: issue.number,
        kind: version === 1 ? "design_added" : "design_versioned", actorId: userId,
        data: { design: designName, version },
      }).catch((err) => request.log.error({ err }, "recordEvent design"));

      return reply.status(201).send({ design: formatDesign(updated), version: formatVersion(designName, created as VersionRecord) });
    },
  );

  // GET .../designs/:designId/versions/:version/raw — stream one version's bytes.
  app.get(
    "/repos/:handle/:name/issues/:number/designs/:designId/versions/:version/raw",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number, designId, version } = request.params as {
        handle: string; name: string; number: string; designId: string; version: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

      const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      const design = await prisma.design.findFirst({ where: { id: designId, issueId: issue.id } });
      if (!design) return reply.status(404).send({ error: "Design not found" });

      const dv = await prisma.designVersion.findFirst({ where: { designId: design.id, version: Number(version) } });
      if (!dv) return reply.status(404).send({ error: "Design version not found" });

      const inline = isImageName(design.name, dv.contentType);
      return reply
        .header("Content-Type", dv.contentType || "application/octet-stream")
        .header("Content-Length", String(dv.size))
        .header("Content-Disposition", contentDisposition(`${design.name}.v${dv.version}`, inline))
        .header("Cache-Control", "private, no-cache")
        .send(readDesignStream(dv.storageKey));
    },
  );

  // GET .../designs/:designId/compare?from=&to= — version-vs-version diff.
  // Reuses the SAME handler.diff() + DiffCache machinery as routes/compare.ts when
  // both versions carry snapshots of the design's handler; visual for images; else
  // a byte summary. The response `mode` makes the branch explicit.
  app.get(
    "/repos/:handle/:name/issues/:number/designs/:designId/compare",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name, number, designId } = request.params as {
        handle: string; name: string; number: string; designId: string;
      };
      const { from, to } = request.query as { from?: string; to?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      const fromV = Number(from);
      const toV = Number(to);
      if (!from || !to || !Number.isInteger(fromV) || !Number.isInteger(toV)) {
        return reply.status(400).send({ error: "Both 'from' and 'to' version numbers are required" });
      }
      if (fromV === toV) {
        return reply.status(400).send({ error: "'from' and 'to' must be different versions" });
      }

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

      const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      const design = await prisma.design.findFirst({ where: { id: designId, issueId: issue.id } });
      if (!design) return reply.status(404).send({ error: "Design not found" });

      const rows = await prisma.designVersion.findMany({
        where: { designId: design.id, version: { in: [fromV, toV] } },
        select: { version: true, storageKey: true, contentType: true, size: true, snapshotId: true },
      });
      const baseV = rows.find((r) => r.version === fromV);
      const headV = rows.find((r) => r.version === toV);
      if (!baseV) return reply.status(404).send({ error: `Version ${fromV} not found` });
      if (!headV) return reply.status(404).send({ error: `Version ${toV} not found` });

      // Handler is resolved by the design's file extension (registry) — designs are
      // not commit-scoped, so no `.forge/formats` opt-in applies. Same name across
      // versions ⇒ same handler; a snapshot on both ⇒ both were ingested by it.
      const handler = designHandlerFor(design.name);
      if (handler && baseV.snapshotId && headV.snapshotId) {
        const [baseBuf, headBuf] = await Promise.all([
          readDesignBuffer(baseV.storageKey),
          readDesignBuffer(headV.storageKey),
        ]);
        const baseBlobSha = gitBlobSha(baseBuf);
        const headBlobSha = gitBlobSha(headBuf);

        // Same DiffCache the PR/commit compare path uses — keyed on git blob shas.
        const cached = await prisma.diffCache.findUnique({
          where: { handlerId_baseBlobSha_headBlobSha: { handlerId: handler.id, baseBlobSha, headBlobSha } },
        });
        let diff: StructuredDiff;
        if (cached) {
          diff = JSON.parse(cached.result) as StructuredDiff;
        } else {
          diff = await handler.diff(baseBuf, headBuf);
          prisma.diffCache.create({
            data: { handlerId: handler.id, baseBlobSha, headBlobSha, result: JSON.stringify(diff) },
          }).catch(() => undefined);
        }

        const changes: DiffChange[] = diff.changes;
        return {
          mode: "semantic" as const,
          handlerId: handler.id,
          format: diff.format,
          version: diff.version,
          from: fromV,
          to: toV,
          changes,
        };
      }

      const bothImages =
        isImageName(design.name, baseV.contentType) && isImageName(design.name, headV.contentType);
      if (bothImages) {
        return {
          mode: "visual" as const,
          from: { version: fromV, contentType: baseV.contentType, size: baseV.size },
          to: { version: toV, contentType: headV.contentType, size: headV.size },
        };
      }

      return {
        mode: "binary" as const,
        from: { version: fromV, contentType: baseV.contentType, size: baseV.size },
        to: { version: toV, contentType: headV.contentType, size: headV.size },
      };
    },
  );

  // DELETE .../designs/:designId — author of the design or a repo writer.
  app.delete(
    "/repos/:handle/:name/issues/:number/designs/:designId",
    { preHandler: [app.authenticate, write] },
    async (request, reply) => {
      const { handle, name, number, designId } = request.params as {
        handle: string; name: string; number: string; designId: string;
      };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

      const issue = await prisma.issue.findFirst({ where: { repoId: repo.id, number: Number(number) } });
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      const design = await prisma.design.findFirst({
        where: { id: designId, issueId: issue.id },
        include: { versions: { select: { storageKey: true } } },
      });
      if (!design) return reply.status(404).send({ error: "Design not found" });

      if (design.createdById !== userId && !canWrite(repo, userId)) {
        return reply.status(403).send({ error: "Only the design author or a repository writer can delete this design" });
      }

      // Best-effort remove the stored bytes; the DB rows cascade on delete.
      for (const v of design.versions) await removeDesign(v.storageKey).catch(() => {});
      await prisma.design.delete({ where: { id: design.id } });

      return reply.status(204).send();
    },
  );
}
