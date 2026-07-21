import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { getComposition } from "../composition.js";

export async function compositionRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/composition?ref=  — byte-share per format/domain at
  // a ref (default branch when omitted). Cached per repo + head sha server-side.
  app.get("/repos/:handle/:name/composition", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) {
      return { ref: "main", sha: null, totalBytes: 0, totalFiles: 0, segments: [] };
    }

    const { ref } = request.query as { ref?: string };
    const composition = await getComposition(repo.storageKey, ref);
    if (!composition) {
      // Empty repo / unresolvable ref — an empty-but-valid composition.
      return { ref: ref ?? "main", sha: null, totalBytes: 0, totalFiles: 0, segments: [] };
    }
    return composition;
  });
}
