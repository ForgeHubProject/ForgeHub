import { basename, extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { readBlobAsBuffer, statBlob } from "../git-utils.js";
import { handlerBuild } from "../fhr/manifest.js";
import { ByteCache, ifNoneMatchHits } from "../fhr/byte-cache.js";
import {
  OFFICIAL_WASM_MAX_BYTES,
  normalizeExt,
  officialConvertFormats,
  officialHandlerId,
  officialWasmConvert,
} from "../fhr/official-handlers.js";

// Transcoding a 3D file to another format (FHR SPEC §7 `import` / `export`):
//
//   GET /convert/formats                                  what can be converted
//   GET /repos/:handle/:name/convert?path=&sha=&to=       one file, as a download
//
// The source handler imports the file to a GLB and the target handler exports
// it, both the manifest's official wasm builds. The result is derived data:
// computed on demand, cached only as a bounded in-memory LRU keyed by (blob
// oid, source handler + build, target handler + build, target), never stored
// beside the repository, and served as an attachment so a converted file is a
// download rather than something the browser renders on this origin.

/** Content types for the formats the family writes; anything else is opaque bytes. */
const MEDIA_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "model/obj",
  ".stl": "model/stl",
  ".3mf": "model/3mf",
};

type CachedConversion = { bytes: Buffer };

const conversionCache = new ByteCache<CachedConversion>(
  Number(process.env["FORGEHUB_CONVERT_CACHE_BYTES"] ?? 64 * 1024 * 1024),
);

/** Test hook: forget computed conversions. */
export function __clearConversionCache(): void {
  conversionCache.clear();
}

/** The download name: the file's own with its extension swapped for the target's. */
function downloadName(filePath: string, to: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}${to}`;
}

/** A Content-Disposition value safe for any file name (RFC 6266 + 5987). */
function attachment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function convertRoutes(app: FastifyInstance) {
  app.get("/convert/formats", async (_request, reply) => {
    try {
      return reply.header("Cache-Control", "public, max-age=300").send({ formats: await officialConvertFormats() });
    } catch {
      return reply.status(503).send({ error: "Official FHR handlers unavailable" });
    }
  });

  app.get(
    "/repos/:handle/:name/convert",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { path: filePath, sha, to } = request.query as { path?: string; sha?: string; to?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!filePath || !sha || !to) {
        return reply.status(400).send({ error: "'path', 'sha' and 'to' query params are required" });
      }
      const target = normalizeExt(to);
      if (!/^\.[a-z0-9]{1,16}$/.test(target)) {
        return reply.status(400).send({ error: "'to' must be a file extension such as glb or .obj" });
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
      // The handlers take whole buffers (FHR #74): refuse before reading the blob.
      if (stat.size > OFFICIAL_WASM_MAX_BYTES) {
        return reply.status(413).send({
          error: "File too large to convert",
          path: filePath,
          size: stat.size,
          limit: OFFICIAL_WASM_MAX_BYTES,
        });
      }

      let fromId: string | null;
      let toId: string | null;
      let fromBuild: string;
      let toBuild: string;
      try {
        fromId = await officialHandlerId(extname(filePath).toLowerCase());
        toId = await officialHandlerId(target);
        fromBuild = (fromId && (await handlerBuild(fromId).catch(() => null))) || "unpinned";
        toBuild = (toId && (await handlerBuild(toId).catch(() => null))) || "unpinned";
      } catch {
        return reply.status(503).send({ error: "Official FHR handler unavailable" });
      }

      const etag = `"${stat.oid}.${fromId}.${fromBuild}.${toId}.${toBuild}.${target}"`;
      // Revalidate rather than `immutable`: the handler builds are not in the URL.
      const cacheControl = `${repo.visibility === "PUBLIC" ? "public" : "private"}, no-cache`;
      if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
        return reply.status(304).header("ETag", etag).header("Cache-Control", cacheControl).send();
      }

      let hit = conversionCache.get(etag);
      if (!hit) {
        const read = await readBlobAsBuffer(storageKey, sha, filePath);
        if (read.kind !== "ok") {
          return reply.status(500).send({ error: "Failed to read file content at this commit" });
        }
        const result = await officialWasmConvert(filePath, target, read.buf);
        switch (result.kind) {
          case "no-source":
            return reply.status(415).send({
              error: `ForgeHub cannot read ${result.ext || "this file"} for conversion`,
              code: "unsupported-source",
            });
          case "no-target":
            return reply.status(400).send({
              error: `ForgeHub cannot write ${result.ext}`,
              code: "unsupported-target",
            });
          case "too-large":
            return reply.status(413).send({ error: "File too large to convert", path: filePath, limit: result.limit });
          case "failed":
            // The handler refused: a malformed file, or something the target
            // format cannot hold — not a server fault.
            return reply.status(422).send({
              error: `The ${result.stage === "import" ? "source" : "target"} handler could not convert this file`,
              stage: result.stage,
              message: result.message,
            });
        }
        hit = { bytes: Buffer.from(result.bytes) };
        conversionCache.set(etag, hit);
      }

      return reply
        .header("Content-Type", MEDIA_TYPES[target] ?? "application/octet-stream")
        .header("Content-Disposition", attachment(downloadName(filePath, target)))
        .header("ETag", etag)
        .header("Cache-Control", cacheControl)
        .header("X-Content-Type-Options", "nosniff")
        .send(hit.bytes);
    },
  );
}
