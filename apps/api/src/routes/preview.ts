import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { readBlobAsBuffer, statBlob } from "../git-utils.js";
import { handlerBuild } from "../fhr/manifest.js";
import {
  OFFICIAL_WASM_MAX_BYTES,
  officialHandlerId,
  officialPreviewType,
  officialWasmPreview,
} from "../fhr/official-handlers.js";

// A handler's preview of one file at a commit (FHR SPEC §7 `preview`): what a
// renderer draws for a format the browser cannot draw from its own bytes. The
// obj handler answers with a GLB whose node names are the names its diff's
// paths use, so the gltf-scene viewport can mount an OBJ file unchanged.
//
// A preview is derived data. It is computed on demand by the same official wasm
// build that computes the diff, never stored in the repository, and cached here
// only as a bounded in-memory LRU. Its identity is (blob oid, handler, handler
// build): the ETag says exactly that, so revalidation is a 304 that runs no
// wasm, and a handler release — which can change the bytes at the same URL —
// is a new ETag rather than a stale `immutable` copy.
export async function previewRoutes(app: FastifyInstance) {
  app.get(
    "/repos/:handle/:name/preview",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { path: filePath, sha } = request.query as { path?: string; sha?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!filePath || !sha) {
        return reply.status(400).send({ error: "'path' and 'sha' query params are required" });
      }
      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      const storageKey = repo.storageKey;
      if (!storageKey) return reply.status(404).send({ error: "Repository has no storage" });

      const stat = await statBlob(storageKey, sha, filePath);
      switch (stat.kind) {
        case "missing":
        case "not-blob":
          return reply.status(404).send({ error: "File not found at this commit" });
        case "invalid":
          return reply.status(400).send({ error: "Invalid 'path' or 'sha'" });
        case "error":
          return reply.status(500).send({ error: "Failed to read file content at this commit" });
      }

      let handlerId: string | null;
      let previewType: string | null;
      try {
        handlerId = await officialHandlerId(extname(filePath).toLowerCase());
        previewType = handlerId ? await officialPreviewType(filePath) : null;
      } catch {
        return reply.status(503).send({ error: "Official FHR handler unavailable" });
      }
      // No official handler, or one that draws from the file's own bytes: there
      // is nothing to convert. `code` lets a client remember that per handler
      // instead of asking again for every file.
      if (!handlerId || !previewType) {
        return reply.status(404).send({ error: "No preview for this file", code: "no-preview", handlerId });
      }
      // The handler takes whole buffers (FHR #74), so this route is capped where
      // every wasm call is. 413 names the real reason and the real size.
      if (stat.size > OFFICIAL_WASM_MAX_BYTES) {
        return reply.status(413).send({
          error: "File too large to preview",
          path: filePath,
          size: stat.size,
          limit: OFFICIAL_WASM_MAX_BYTES,
        });
      }

      const build = (await handlerBuild(handlerId).catch(() => null)) ?? "unpinned";
      const etag = `"${stat.oid}.${handlerId}.${build}"`;
      // Revalidate rather than `immutable`: the handler build is not in the URL.
      const cacheControl = `${repo.visibility === "PUBLIC" ? "public" : "private"}, no-cache`;
      if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
        return reply.status(304).header("ETag", etag).header("Cache-Control", cacheControl).send();
      }

      let hit = previewCache.get(etag);
      if (!hit) {
        const read = await readBlobAsBuffer(storageKey, sha, filePath);
        if (read.kind !== "ok") {
          return reply.status(500).send({ error: "Failed to read file content at this commit" });
        }
        const result = await officialWasmPreview(filePath, read.buf);
        switch (result.kind) {
          case "none":
            return reply.status(404).send({ error: "No preview for this file", code: "no-preview", handlerId });
          case "too-large":
            return reply.status(413).send({ error: "File too large to preview", path: filePath, limit: result.limit });
          case "failed":
            // The handler refused the file — malformed input, not a server fault.
            return reply.status(422).send({ error: "The handler could not preview this file", message: result.message });
        }
        hit = { bytes: Buffer.from(result.bytes), mediaType: result.mediaType };
        previewCache.set(etag, hit);
      }

      return reply
        .header("Content-Type", hit.mediaType)
        .header("ETag", etag)
        .header("Cache-Control", cacheControl)
        .header("X-Content-Type-Options", "nosniff")
        .send(hit.bytes);
    },
  );
}

type CachedPreview = { bytes: Buffer; mediaType: string };

/**
 * A byte-bounded LRU of computed previews, keyed by ETag (blob oid + handler +
 * build — content-addressed, so an entry is never stale). The base and head of
 * one diff, viewed by several reviewers, are converted once.
 */
class PreviewCache {
  private entries = new Map<string, CachedPreview>();
  private bytes = 0;

  constructor(private readonly budget: number) {}

  get(key: string): CachedPreview | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert to mark it most recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: CachedPreview): void {
    if (value.bytes.length > this.budget) return;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes.length;
    }
    this.entries.set(key, value);
    this.bytes += value.bytes.length;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.budget) break;
      this.entries.delete(k);
      this.bytes -= v.bytes.length;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

const previewCache = new PreviewCache(
  Number(process.env["FORGEHUB_PREVIEW_CACHE_BYTES"] ?? 64 * 1024 * 1024),
);

/** Test hook: forget computed previews. */
export function __clearPreviewCache(): void {
  previewCache.clear();
}

/** RFC 9110 If-None-Match, weak comparison (as /rawblob does). */
function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  return raw.split(",").some((candidate) => {
    const value = strip(candidate);
    return value === "*" || value === etag;
  });
}
