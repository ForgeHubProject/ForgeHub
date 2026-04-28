import type { FastifyInstance } from "fastify";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { createTag, deleteTag, listTags } from "../git-utils.js";

export async function tagRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/tags
  app.get("/repos/:handle/:name/tags", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.send({ tags: [] });
    const tags = await listTags(repo.storageKey);
    return { tags };
  });

  // POST /repos/:handle/:name/tags
  app.post("/repos/:handle/:name/tags", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const { tag, sha, message } = request.body as { tag?: string; sha?: string; message?: string };
    if (!tag || !/^[\w/._-]+$/.test(tag)) return reply.status(400).send({ error: "Invalid tag name" });
    if (!sha) return reply.status(400).send({ error: "sha is required" });

    try {
      await createTag(repo.storageKey, tag, sha, message);
      return reply.status(201).send({ tag });
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  // DELETE /repos/:handle/:name/tags/:tag
  app.delete("/repos/:handle/:name/tags/:tag", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, tag } = request.params as { handle: string; name: string; tag: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    try {
      await deleteTag(repo.storageKey, tag);
      return reply.status(204).send();
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });
}
