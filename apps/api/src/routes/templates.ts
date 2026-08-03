import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { loadRepoTemplates } from "../repo-templates.js";

export async function templateRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/templates — the repo's issue / PR templates from
  // the default branch (issue #89). Same read-access model as the neighbouring
  // repo routes: public repos are open, private ones 404 without read access.
  // `?ref=` reads templates from another branch (compose-from-a-branch flows).
  app.get("/repos/:handle/:name/templates", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref } = request.query as { ref?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    return loadRepoTemplates(repo.storageKey, ref?.trim() || undefined);
  });
}
