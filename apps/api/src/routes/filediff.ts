import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { git, readBlobAsBuffer, activeFormatsAtCommit } from "../git-utils.js";
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

      // FHR's manifest is the single source of truth for what is semantically
      // diffable: a file qualifies iff the manifest maps its extension to an
      // official handler AND the repo opted the extension in (its .forge/formats
      // at this commit). ForgeHub holds no format knowledge of its own and no
      // longer consults its built-in handler registry to decide this — that
      // built-in TS fallback has been retired from this path (#74). A community
      // (non-official) extension resolves to null here and is never run
      // server-side; that path belongs to the consented client sandbox (#70).
      const activeExts = await activeFormatsAtCommit(storageKey, sha);
      const ext = extname(filePath).toLowerCase();
      let handlerId: string | null;
      try {
        handlerId = await officialHandlerId(ext);
      } catch {
        // Manifest unreachable with no cached copy — can't authorize a diff.
        return reply.status(503).send({ error: "Official FHR handler unavailable and no local fallback" });
      }
      if (!activeExts.has(ext) || !handlerId) {
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

      // The official FHR wasm handler (resolved from the manifest) is the only
      // engine — the exact binary forge runs, so ForgeHub's diff matches the
      // CLI's (closes the producer/consumer drift in #59). The built-in TS
      // handler has been retired from this path (#74): when the official wasm
      // handler can't run (release unreachable or the input is rejected), we
      // return 503 rather than substituting a different engine's answer.
      // The base/head commit SHAs are returned so a client renderer (e.g. the 3D
      // scene) can fetch the raw blobs via /rawblob to build geometry.
      const shas = { baseSha: baseSha ?? null, headSha: sha };
      try {
        const official = await officialWasmDiff(filePath, activeExts, baseBlob, headBlob);
        if (!official) {
          return reply.status(503).send({ error: "Official FHR handler unavailable and no local fallback" });
        }
        return { ...official.diff, handlerId: official.handlerId, path: filePath, engine: "wasm", ...shas };
      } catch (e) {
        return reply.status(500).send({ error: `diff failed: ${String(e)}` });
      }
    },
  );

  // Raw file bytes at a commit, as application/octet-stream — used by client
  // renderers that need the actual file (the gltf-scene 3D viewport fetches the
  // head blob to build its mesh). readBlobAsBuffer preserves binary content,
  // unlike the utf-8 /blob endpoints.
  app.get(
    "/repos/:handle/:name/rawblob",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { path: filePath, sha } = request.query as { path?: string; sha?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!filePath || !sha) {
        return reply.status(400).send({ error: "'path' and 'sha' query params are required" });
      }
      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      if (!repo.storageKey) return reply.status(404).send({ error: "Repository has no storage" });

      const buf = await readBlobAsBuffer(repo.storageKey, sha, filePath);
      if (!buf) return reply.status(404).send({ error: "File not found at this commit" });

      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "public, max-age=3600")
        .send(buf);
    },
  );
}
