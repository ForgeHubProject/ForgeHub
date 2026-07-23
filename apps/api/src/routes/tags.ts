import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { createTag, deleteTag, listTags, tagExists } from "../git-utils.js";
import { isTagProtected, protectedTagPatterns, syncProtectedTagsConfig } from "../protected-tags.js";

export async function tagRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to mutate tags / tag protection; session/JWT
  // auth is unscoped and no-ops this guard (issue #87). Route bodies keep their
  // own writer/owner checks.
  const write = app.requireScope("repo:write");

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
  app.post("/repos/:handle/:name/tags", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const { tag, sha, message } = request.body as { tag?: string; sha?: string; message?: string };
    if (!tag || !/^[\w/._-]+$/.test(tag)) return reply.status(400).send({ error: "Invalid tag name" });
    if (!sha) return reply.status(400).send({ error: "sha is required" });

    // Overwriting an existing protected tag is refused; creating a brand-new tag
    // (even one matching a protected pattern) is allowed so releases keep working.
    if (await tagExists(repo.storageKey, tag)) {
      const patterns = await protectedTagPatterns(repo.id);
      if (isTagProtected(patterns, tag)) {
        return reply.status(409).send({ error: `Tag "${tag}" is protected and cannot be overwritten` });
      }
    }

    try {
      await createTag(repo.storageKey, tag, sha, message);
      return reply.status(201).send({ tag });
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  // DELETE /repos/:handle/:name/tags/:tag
  app.delete("/repos/:handle/:name/tags/:tag", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, tag } = request.params as { handle: string; name: string; tag: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    const patterns = await protectedTagPatterns(repo.id);
    if (isTagProtected(patterns, tag)) {
      return reply.status(403).send({ error: `Tag "${tag}" is protected and cannot be deleted` });
    }

    try {
      await deleteTag(repo.storageKey, tag);
      return reply.status(204).send();
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  // ─── protected-tag rules (issue #117) ───────────────────────────────────────

  // GET /repos/:handle/:name/protected-tags
  app.get("/repos/:handle/:name/protected-tags", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    const rows = await prisma.protectedTag.findMany({
      where: { repoId: repo.id },
      orderBy: { pattern: "asc" },
    });
    return {
      protectedTags: rows.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // POST /repos/:handle/:name/protected-tags — add a pattern (owner only)
  app.post("/repos/:handle/:name/protected-tags", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId !== userId) return reply.status(403).send({ error: "Only the owner can protect tags" });

    const { pattern } = request.body as { pattern?: string };
    const trimmed = pattern?.trim();
    // Tag names plus the `*` glob wildcard; keep it tight to avoid regex surprises.
    if (!trimmed || !/^[\w/.*_-]+$/.test(trimmed)) {
      return reply.status(400).send({ error: "Invalid tag pattern" });
    }

    try {
      const row = await prisma.protectedTag.create({ data: { repoId: repo.id, pattern: trimmed } });
      if (repo.storageKey) {
        await syncProtectedTagsConfig(repo.id, repo.storageKey).catch((err) =>
          request.log.error({ err }, "syncProtectedTagsConfig (protect)"),
        );
      }
      return reply.status(201).send({ id: row.id, pattern: row.pattern, createdAt: row.createdAt.toISOString() });
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return reply.status(409).send({ error: "Pattern already protected" });
      }
      throw e;
    }
  });

  // DELETE /repos/:handle/:name/protected-tags/:id — remove a pattern (owner only)
  app.delete("/repos/:handle/:name/protected-tags/:id", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId !== userId) return reply.status(403).send({ error: "Only the owner can unprotect tags" });

    const row = await prisma.protectedTag.findFirst({ where: { id, repoId: repo.id } });
    if (!row) return reply.status(404).send({ error: "Protected tag not found" });

    await prisma.protectedTag.delete({ where: { id } });
    if (repo.storageKey) {
      await syncProtectedTagsConfig(repo.id, repo.storageKey).catch((err) =>
        request.log.error({ err }, "syncProtectedTagsConfig (unprotect)"),
      );
    }
    return reply.status(204).send();
  });
}
