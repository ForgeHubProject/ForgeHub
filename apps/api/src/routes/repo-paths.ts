import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { listPathsAtRef } from "../repo-paths.js";

export async function repoPathsRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/paths?ref=  — every file path at a ref (default
  // branch when omitted), for the file page's "Go to file" search (#223).
  // `truncated` says the list stopped at MAX_PATHS.
  app.get("/repos/:handle/:name/paths", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { ref } = request.query as { ref?: string };
    const result = repo.storageKey ? await listPathsAtRef(repo.storageKey, ref) : null;
    if (!result) return reply.status(404).send({ error: "Ref not found" });
    return result;
  });
}
