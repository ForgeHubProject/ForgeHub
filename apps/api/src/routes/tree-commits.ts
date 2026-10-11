import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { getTreeCommits } from "../tree-commits.js";

export async function treeCommitsRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/tree-commits?ref=&path=  — the last commit to touch
  // each entry directly under `path` (repo root when omitted), for the file
  // list's message and date columns (issue #210). The web asks for this after
  // the listing has rendered; nothing waits on it.
  app.get("/repos/:handle/:name/tree-commits", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { ref, path } = request.query as { ref?: string; path?: string };
    const result = repo.storageKey ? await getTreeCommits(repo.storageKey, path ?? "", ref) : null;
    if (!result) {
      return { ref: ref ?? null, sha: null, path: path ?? "", commits: {}, complete: true, totalCommits: 0 };
    }
    return result;
  });
}
