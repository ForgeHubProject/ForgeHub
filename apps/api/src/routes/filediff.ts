import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { git, readBlobAsBuffer, activeFormatsAtCommit } from "../git-utils.js";
import { firstHandlerForPathAndFormats } from "../handlers/index.js";

// Semantic diff for a single file across one commit, computed on demand from
// the two git blobs. This is the bridge that lets the commit/PR file views show
// a format-aware diff (e.g. a glTF scene change tree) where a text patch would
// be meaningless — rendered by the FHR renderer bundle (SPEC-RENDERING §4).
export async function fileDiffRoutes(app: FastifyInstance) {
  app.get(
    "/repos/:handle/:name/filediff",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { path: filePath, sha, base } = request.query as {
        path?: string;
        sha?: string;
        base?: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!filePath || !sha) {
        return reply.status(400).send({ error: "'path' and 'sha' query params are required" });
      }

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      const storageKey = repo.storageKey;
      if (!storageKey) return reply.status(404).send({ error: "Repository has no storage" });

      // Only files the repo opted into (its .forge/formats at this commit) get a
      // semantic handler; everything else falls back to the text patch view.
      const activeExts = await activeFormatsAtCommit(storageKey, sha);
      const handler = firstHandlerForPathAndFormats(filePath, activeExts);
      if (!handler) {
        return reply.status(404).send({ error: "No semantic handler for this file" });
      }

      // Base defaults to the commit's first parent; absent (root commit or an
      // added file) means an empty base blob.
      let baseSha = base;
      if (!baseSha) {
        try {
          baseSha = await git(storageKey, ["rev-parse", `${sha}^`]);
        } catch {
          baseSha = undefined;
        }
      }

      const [baseBuf, headBuf] = await Promise.all([
        baseSha ? readBlobAsBuffer(storageKey, baseSha, filePath) : Promise.resolve(null),
        readBlobAsBuffer(storageKey, sha, filePath),
      ]);

      if (!baseBuf && !headBuf) {
        return reply.status(404).send({ error: "File not found at this commit" });
      }

      try {
        const diff = await handler.diff(baseBuf ?? Buffer.alloc(0), headBuf ?? Buffer.alloc(0));
        return { ...diff, handlerId: handler.id, path: filePath };
      } catch (e) {
        return reply.status(500).send({ error: `diff failed: ${String(e)}` });
      }
    },
  );
}
