import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { git, readBlobAsBuffer, activeFormatsAtCommit } from "../git-utils.js";
import { firstHandlerForPathAndFormats } from "../handlers/index.js";
import { officialHandlerId, officialWasmDiff } from "../fhr/official-handlers.js";

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

      // FHR is the authority on what is semantically diffable: a file qualifies
      // iff an *official* FHR handler covers its extension AND the repo opted the
      // extension in (its .forge/formats at this commit). ForgeHub no longer
      // consults its own built-in handler registry to make this decision — the
      // built-in handler is only an offline fallback for computing the diff when
      // the FHR release is unreachable (retirement tracked in #74). A community
      // (non-official) handler resolves to null here and is never run
      // server-side; that path belongs to the consented client sandbox (#70).
      const activeExts = await activeFormatsAtCommit(storageKey, sha);
      const ext = extname(filePath).toLowerCase();
      if (!activeExts.has(ext) || !officialHandlerId(ext)) {
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

      const baseBlob = baseBuf ?? Buffer.alloc(0);
      const headBlob = headBuf ?? Buffer.alloc(0);

      // The official FHR wasm handler is the engine — the exact binary forge
      // runs, so ForgeHub's diff matches the CLI's (closes the producer/consumer
      // drift in #59). The built-in TS handler is consulted only as an offline
      // fallback when the FHR release is unreachable or rejects the input; it is
      // being retired (#74) and is never the authority.
      try {
        const official = await officialWasmDiff(filePath, activeExts, baseBlob, headBlob);
        if (official) {
          return { ...official.diff, handlerId: official.handlerId, path: filePath, engine: "wasm" };
        }
        const fallback = firstHandlerForPathAndFormats(filePath, activeExts);
        if (!fallback) {
          return reply.status(503).send({ error: "Official FHR handler unavailable and no local fallback" });
        }
        const diff = await fallback.diff(baseBlob, headBlob);
        return { ...diff, handlerId: fallback.id, path: filePath, engine: "builtin" };
      } catch (e) {
        return reply.status(500).send({ error: `diff failed: ${String(e)}` });
      }
    },
  );
}
