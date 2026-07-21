import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { createTag, tagExists, defaultBranch, resolvePreviousTag, listRangeCommits } from "../git-utils.js";
import {
  buildAssetStorageKey, writeAssetStream, readAssetStream, removeAsset,
} from "../git-storage.js";
import { notifySubscribers } from "../notifications-service.js";

const assetInclude = { uploadedBy: { select: { handle: true } } } as const;
const releaseInclude = {
  author: { select: { handle: true } },
  assets: { include: assetInclude, orderBy: { createdAt: "asc" } },
} as const;

type AssetRecord = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  downloadCount: number;
  uploadedBy?: { handle: string } | null;
  createdAt: Date;
};

function formatAsset(a: AssetRecord) {
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    contentType: a.contentType,
    downloadCount: a.downloadCount,
    uploader: a.uploadedBy?.handle ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function formatRelease(r: {
  id: string;
  tagName: string;
  name: string;
  body: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  author: { handle: string };
  assets?: AssetRecord[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    tagName: r.tagName,
    name: r.name,
    body: r.body,
    isDraft: r.isDraft,
    isPrerelease: r.isPrerelease,
    author: r.author.handle,
    assets: (r.assets ?? []).map(formatAsset),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Asset file names must be a single safe path segment: no slashes, no "..",
// no control characters. Returns the trimmed name or null if unacceptable.
export function sanitizeAssetName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const name = raw.trim();
  if (!name || name.length > 200) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return null;
  return name;
}

// A Content-Disposition value that is safe for arbitrary UTF-8 file names.
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function releaseRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/releases
  app.get("/repos/:handle/:name/releases", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const isWriter = canWrite(repo, userId);
    const releases = await prisma.release.findMany({
      where: { repoId: repo.id, ...(isWriter ? {} : { isDraft: false }) },
      include: releaseInclude,
      orderBy: { createdAt: "desc" },
    });
    return { releases: releases.map(formatRelease) };
  });

  // GET /repos/:handle/:name/releases/latest
  app.get("/repos/:handle/:name/releases/latest", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const release = await prisma.release.findFirst({
      where: { repoId: repo.id, isDraft: false, isPrerelease: false },
      include: releaseInclude,
      orderBy: { createdAt: "desc" },
    });
    if (!release) return reply.status(404).send({ error: "No release found" });
    return formatRelease(release);
  });

  // GET /repos/:handle/:name/releases/tags/:tag
  app.get("/repos/:handle/:name/releases/tags/:tag", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, tag } = request.params as { handle: string; name: string; tag: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const release = await prisma.release.findFirst({
      where: { repoId: repo.id, tagName: tag },
      include: releaseInclude,
    });
    if (!release) return reply.status(404).send({ error: "Release not found" });
    if (release.isDraft && !canWrite(repo, userId)) return reply.status(404).send({ error: "Release not found" });
    return formatRelease(release);
  });

  // POST /repos/:handle/:name/releases
  app.post("/repos/:handle/:name/releases", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const {
      tagName,
      targetCommitish,
      name: releaseName,
      body,
      isDraft = false,
      isPrerelease = false,
    } = request.body as {
      tagName?: string;
      targetCommitish?: string;
      name?: string;
      body?: string;
      isDraft?: boolean;
      isPrerelease?: boolean;
    };

    if (!tagName || !/^[\w/._-]+$/.test(tagName)) {
      return reply.status(400).send({ error: "tagName is required and must be a valid tag name" });
    }

    // Check for duplicate release
    const existing = await prisma.release.findFirst({ where: { repoId: repo.id, tagName } });
    if (existing) return reply.status(409).send({ error: "A release for this tag already exists" });

    // Create the git tag if it doesn't exist yet
    if (repo.storageKey) {
      const exists = await tagExists(repo.storageKey, tagName);
      if (!exists) {
        if (!targetCommitish) {
          return reply.status(422).send({ error: "Tag does not exist; provide targetCommitish to create it" });
        }
        try {
          await createTag(repo.storageKey, tagName, targetCommitish, releaseName ?? tagName);
        } catch (e) {
          return reply.status(422).send({ error: `Could not create tag: ${String(e)}` });
        }
      }
    }

    const release = await prisma.release.create({
      data: {
        repoId: repo.id,
        tagName,
        name: releaseName ?? tagName,
        body: body ?? null,
        isDraft,
        isPrerelease,
        authorId: userId,
      },
      include: releaseInclude,
    });

    if (!isDraft) {
      void notifySubscribers({ actorId: userId, repoId: repo.id, subjectType: "RELEASE", subjectId: release.id, subjectTitle: release.name, reason: "SUBSCRIBED" });
    }

    return reply.status(201).send(formatRelease(release));
  });

  // PATCH /repos/:handle/:name/releases/:id
  app.patch("/repos/:handle/:name/releases/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    const { name: releaseName, body, isDraft, isPrerelease } = request.body as {
      name?: string;
      body?: string;
      isDraft?: boolean;
      isPrerelease?: boolean;
    };

    const updated = await prisma.release.update({
      where: { id },
      data: {
        ...(releaseName !== undefined ? { name: releaseName } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(isDraft !== undefined ? { isDraft } : {}),
        ...(isPrerelease !== undefined ? { isPrerelease } : {}),
      },
      include: releaseInclude,
    });

    return formatRelease(updated);
  });

  // DELETE /repos/:handle/:name/releases/:id  (leaves git tag intact)
  app.delete("/repos/:handle/:name/releases/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    await prisma.release.delete({ where: { id } });
    return reply.status(204).send();
  });

  // POST /repos/:handle/:name/releases/generate-notes
  // Render a Markdown changelog for a target ref vs the previous tag (or root).
  app.post("/repos/:handle/:name/releases/generate-notes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const { tagName, previousTag, target } = request.body as {
      tagName?: string;
      previousTag?: string;
      target?: string;
    };
    if (!tagName || !tagName.trim()) {
      return reply.status(400).send({ error: "tagName is required" });
    }

    // Resolve the ref we compute notes up to. If the tag doesn't exist yet
    // (composing a new release), fall back to the given target or default branch.
    let targetRef = tagName.trim();
    let previous: string | null = previousTag?.trim() || null;
    let commits: Awaited<ReturnType<typeof listRangeCommits>> = [];
    if (repo.storageKey) {
      if (!(await tagExists(repo.storageKey, targetRef))) {
        targetRef = (target && target.trim()) || (await defaultBranch(repo.storageKey));
      }
      if (!previous) previous = await resolvePreviousTag(repo.storageKey, targetRef);
      commits = await listRangeCommits(repo.storageKey, previous, targetRef);
    }

    // Prefer merged-PR titles when a commit references a known PR number.
    const merged = await prisma.pullRequest.findMany({
      where: { repoId: repo.id, state: "MERGED" },
      select: { number: true, title: true, author: { select: { handle: true } } },
    });
    const prByNumber = new Map(merged.map((pr) => [pr.number, pr]));

    const lines: string[] = [];
    const seenPR = new Set<number>();
    for (const c of commits) {
      const m = c.subject.match(/[#!](\d+)/);
      const prNum = m ? Number(m[1]) : null;
      if (prNum !== null && prByNumber.has(prNum)) {
        if (!seenPR.has(prNum)) {
          seenPR.add(prNum);
          const pr = prByNumber.get(prNum)!;
          lines.push(`- ${pr.title} (!${prNum} by @${pr.author.handle})`);
        }
      } else if (c.parents.length < 2) {
        // Skip merge commits that don't reference a PR; keep real commit subjects.
        lines.push(`- ${c.subject}`);
      }
    }

    const changelog = previous ? `\`${previous}...${tagName.trim()}\`` : `\`${tagName.trim()}\``;
    const bodyLines = ["## What's changed", ""];
    bodyLines.push(...(lines.length ? lines : ["- No changes since the previous release."]));
    bodyLines.push("", `**Full changelog**: ${changelog}`);

    return { tagName: tagName.trim(), previousTag: previous, body: bodyLines.join("\n") };
  });

  // POST /repos/:handle/:name/releases/:id/assets  (writer, multipart upload)
  app.post("/repos/:handle/:name/releases/:id/assets", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    let data;
    try {
      data = await request.file();
    } catch {
      return reply.status(400).send({ error: "Invalid multipart upload" });
    }
    if (!data) return reply.status(400).send({ error: "A file is required" });

    const safeName = sanitizeAssetName(data.filename);
    if (!safeName) {
      data.file.resume();
      return reply.status(400).send({ error: "Invalid asset file name" });
    }

    const dup = await prisma.releaseAsset.findFirst({ where: { releaseId: id, name: safeName } });
    if (dup) {
      data.file.resume();
      return reply.status(409).send({ error: "An asset with this name already exists on the release" });
    }

    const storageKey = buildAssetStorageKey(repo.storageKey ?? repo.id, id, safeName);
    let size: number;
    try {
      size = await writeAssetStream(storageKey, data.file);
    } catch {
      await removeAsset(storageKey).catch(() => {});
      return reply.status(500).send({ error: "Failed to store asset" });
    }
    if (data.file.truncated) {
      await removeAsset(storageKey).catch(() => {});
      return reply.status(413).send({ error: "File exceeds the maximum asset size" });
    }

    let asset;
    try {
      asset = await prisma.releaseAsset.create({
        data: {
          releaseId: id,
          name: safeName,
          contentType: data.mimetype || "application/octet-stream",
          size,
          storageKey,
          uploadedById: userId,
        },
        include: assetInclude,
      });
    } catch {
      await removeAsset(storageKey).catch(() => {});
      return reply.status(409).send({ error: "An asset with this name already exists on the release" });
    }

    return reply.status(201).send(formatAsset(asset));
  });

  // GET /repos/:handle/:name/releases/:id/assets/:assetId  (stream bytes, count++)
  app.get("/repos/:handle/:name/releases/:id/assets/:assetId", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, id, assetId } = request.params as { handle: string; name: string; id: string; assetId: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });
    if (release.isDraft && !canWrite(repo, userId)) return reply.status(404).send({ error: "Release not found" });

    const asset = await prisma.releaseAsset.findFirst({ where: { id: assetId, releaseId: id } });
    if (!asset) return reply.status(404).send({ error: "Asset not found" });

    await prisma.releaseAsset.update({ where: { id: asset.id }, data: { downloadCount: { increment: 1 } } });

    const stream = readAssetStream(asset.storageKey);
    return reply
      .header("Content-Type", asset.contentType || "application/octet-stream")
      .header("Content-Length", String(asset.size))
      .header("Content-Disposition", contentDisposition(asset.name))
      .header("Cache-Control", "private, no-cache")
      .send(stream);
  });

  // DELETE /repos/:handle/:name/releases/:id/assets/:assetId  (writer)
  app.delete("/repos/:handle/:name/releases/:id/assets/:assetId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, id, assetId } = request.params as { handle: string; name: string; id: string; assetId: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const release = await prisma.release.findFirst({ where: { id, repoId: repo.id } });
    if (!release) return reply.status(404).send({ error: "Release not found" });

    const asset = await prisma.releaseAsset.findFirst({ where: { id: assetId, releaseId: id } });
    if (!asset) return reply.status(404).send({ error: "Asset not found" });

    await removeAsset(asset.storageKey).catch(() => {});
    await prisma.releaseAsset.delete({ where: { id: asset.id } });
    return reply.status(204).send();
  });
}
