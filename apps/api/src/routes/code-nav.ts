import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import {
  compareRefs,
  defaultBranch,
  getBlame,
  getMergeBaseDiff,
  resolveRefSha,
} from "../git-utils.js";

/**
 * Code-navigation primitives that wrap `git` plumbing on the bare repo: line
 * blame, a canonical-SHA resolver for permalinks, streaming source archives, and
 * arbitrary ref-to-ref comparison. Every route is gated by the same `canRead`
 * check the blob/tree routes use.
 */
export async function codeNavRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/blame?ref=&path=
  app.get("/repos/:handle/:name/blame", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref: refQ, path: filePath } = request.query as { ref?: string; path?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey || !filePath) return reply.status(404).send({ error: "Missing path" });

    const ref = refQ ?? await defaultBranch(repo.storageKey);
    const hunks = await getBlame(repo.storageKey, ref, filePath);
    if (hunks.length === 0) return reply.status(404).send({ error: "File not found or has no history" });
    return { ref, path: filePath, hunks };
  });

  // GET /repos/:handle/:name/resolve-ref?ref=  → canonical commit SHA (for permalinks)
  app.get("/repos/:handle/:name/resolve-ref", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref: refQ } = request.query as { ref?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const ref = refQ ?? await defaultBranch(repo.storageKey);
    const sha = await resolveRefSha(repo.storageKey, ref);
    if (!sha) return reply.status(404).send({ error: "Ref not found" });
    return { ref, sha };
  });

  // GET /repos/:handle/:name/archive?ref=&format=zip|tar.gz  → streamed source download
  app.get("/repos/:handle/:name/archive", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref: refQ, format: formatQ } = request.query as { ref?: string; format?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const format = formatQ === "tar.gz" ? "tar.gz" : "zip";
    const ref = refQ ?? await defaultBranch(repo.storageKey);
    // Validate the ref up front so a bad ref is a clean 404 rather than a broken
    // stream after headers are already flushed.
    const sha = await resolveRefSha(repo.storageKey, ref);
    if (!sha) return reply.status(404).send({ error: "Ref not found" });

    const repoPath = bareRepoPathFromKey(repo.storageKey);
    const refLabel = ref.replace(/[^\w.-]+/g, "-");
    const ext = format === "tar.gz" ? "tar.gz" : "zip";
    const contentType = format === "tar.gz" ? "application/gzip" : "application/zip";

    const gitFormat = format === "tar.gz" ? "tar.gz" : "zip";
    const child = spawn("git", ["archive", `--format=${gitFormat}`, `--prefix=${name}-${refLabel}/`, ref], { cwd: repoPath });

    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", contentType);
    reply.raw.setHeader("Content-Disposition", `attachment; filename="${name}-${refLabel}.${ext}"`);
    reply.raw.setHeader("Cache-Control", "no-cache");

    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", () => { try { reply.raw.destroy(); } catch { /* noop */ } });
    child.on("close", (code) => {
      if (code !== 0) {
        app.log.error({ stderr }, "git archive failed");
        if (!reply.raw.headersSent) reply.raw.statusCode = 500;
        try { reply.raw.end(); } catch { /* noop */ }
      }
    });
    child.stdout.pipe(reply.raw);
    return reply;
  });

  // GET /repos/:handle/:name/ref-compare?base=&head=  → ahead/behind + commits + file stats
  app.get("/repos/:handle/:name/ref-compare", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { base: baseQ, head: headQ } = request.query as { base?: string; head?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const base = baseQ ?? await defaultBranch(repo.storageKey);
    if (!headQ) return reply.status(400).send({ error: "'head' query param is required" });

    const result = await compareRefs(repo.storageKey, base, headQ);
    if (!result) return reply.status(404).send({ error: "One or both refs could not be resolved" });
    return result;
  });

  // GET /repos/:handle/:name/ref-compare/diff?base=&head=&path=  → full per-file diffs (merge-base)
  app.get("/repos/:handle/:name/ref-compare/diff", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { base: baseQ, head: headQ, path: pathQ } = request.query as { base?: string; head?: string; path?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const base = baseQ ?? await defaultBranch(repo.storageKey);
    if (!headQ) return reply.status(400).send({ error: "'head' query param is required" });

    const files = await getMergeBaseDiff(repo.storageKey, base, headQ, pathQ);
    return { files };
  });
}
