import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { activeFormatsAtCommit, blobSizeAtCommit, defaultBranch, resolveRefSha } from "../git-utils.js";
import { officialHandlerId } from "../fhr/official-handlers.js";
import { canRead, resolveRepo } from "../repo-access.js";

export async function blobMetaRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/blob-meta?ref=&path=  — what the file page's
  // header says about any file (#225), without downloading it: its size (from
  // the tree, so a 3D model's is known too), and, when FHR's manifest has a
  // handler for its extension, which one and whether this repo has semantic
  // diffs on for it (its .forge/formats at that commit).
  app.get("/repos/:handle/:name/blob-meta", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref: refQ, path } = request.query as { ref?: string; path?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    if (!path) return reply.status(400).send({ error: "'path' is required" });

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    const storageKey = repo.storageKey;
    if (!storageKey) return reply.status(404).send({ error: "No git storage" });

    const ref = refQ ?? (await defaultBranch(storageKey));
    if (!ref || ref.startsWith("-")) return reply.status(404).send({ error: "Ref not found" });
    const sha = await resolveRefSha(storageKey, ref);
    if (!sha) return reply.status(404).send({ error: "Ref not found" });
    const size = await blobSizeAtCommit(storageKey, sha, path);
    if (size === null) return reply.status(404).send({ error: "File not found" });

    const ext = extname(path).toLowerCase();
    let handlerId: string | null = null;
    try {
      handlerId = ext ? await officialHandlerId(ext) : null;
    } catch {
      handlerId = null; // manifest unreachable: the size still stands
    }
    const semanticDiffs = handlerId ? (await activeFormatsAtCommit(storageKey, sha)).has(ext) : false;
    return { ref, sha, path, size, format: handlerId ? { ext, handlerId, semanticDiffs } : null };
  });
}
