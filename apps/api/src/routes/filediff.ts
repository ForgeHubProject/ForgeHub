import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { git, readBlobAsBuffer, activeFormatsAtCommit, BLOB_BUFFER_MAX } from "../git-utils.js";
import type { BlobReadResult } from "../git-utils.js";
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
      if (!handlerId) {
        // Genuinely unsupported: no official handler exists for this extension
        // at all — nothing to opt into, so the honest 404 stands and the client
        // falls back to its raw/text diff.
        return reply.status(404).send({ error: "No semantic handler for this file" });
      }
      if (!activeExts.has(ext)) {
        // Fixable: an official handler exists, the repo just hasn't opted the
        // extension into .forge/formats at this commit. Not an error — answer
        // 200 with a structured call-to-action payload the web view renders as
        // "run this to enable it" instead of a dead-end (#73). The hint lists
        // both verbs: `add` opts in, `ignore` records a deliberate opt-out and
        // silences the nudge (forge#31).
        return {
          status: "format-not-enabled",
          path: filePath,
          ext,
          message: `Format ${ext} is not added to this repo's .forge/formats.`,
          hint: [`forge formats add ${ext}`, `forge formats ignore ${ext}`],
        };
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

      const absent: BlobReadResult = { kind: "missing" };
      const [baseRead, headRead] = await Promise.all([
        baseSha ? readBlobAsBuffer(storageKey, baseSha, filePath) : Promise.resolve(absent),
        readBlobAsBuffer(storageKey, sha, filePath),
      ]);

      // The semantic engine is wasm and takes whole buffers, so this route is
      // genuinely capped — but a file over the cap is present, and saying
      // "File not found at this commit" about it is a lie (#157). 413 names the
      // real reason and carries the real size, so the client can say something
      // true and a bug report can quote a number.
      const oversized = [headRead, baseRead].find((r) => r.kind === "too-large");
      if (oversized?.kind === "too-large") {
        return reply.status(413).send({
          error: "File too large to diff",
          path: filePath,
          size: oversized.size,
          limit: BLOB_BUFFER_MAX,
        });
      }
      if (headRead.kind === "error" || baseRead.kind === "error") {
        return reply.status(500).send({ error: "Failed to read file content at this commit" });
      }
      // Only a genuinely absent path (or a directory, which is not a file at
      // all) reaches the 404 now. An added file still has a missing base and
      // diffs against empty bytes, exactly as before.
      if (headRead.kind !== "ok" && baseRead.kind !== "ok") {
        return reply.status(404).send({ error: "File not found at this commit" });
      }

      const baseBlob = baseRead.kind === "ok" ? baseRead.buf : Buffer.alloc(0);
      const headBlob = headRead.kind === "ok" ? headRead.buf : Buffer.alloc(0);

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

      const read = await readBlobAsBuffer(repo.storageKey, sha, filePath);
      switch (read.kind) {
        case "missing":
        // A tree/tag/commit at that path is not file bytes, and this route only
        // hands over file bytes. (It used to answer a directory with 200 and a
        // pretty-printed tree listing, because `git show <sha>:<dir>` exits 0.)
        case "not-blob":
          return reply.status(404).send({ error: "File not found at this commit" });
        case "too-large":
          // Present, readable, and larger than this process is willing to hold
          // in memory. That is a ForgeHub implementation limit, not a property
          // of the file, and it is temporary: #157 phase 2 streams this route
          // and drops the ceiling entirely. Until then, say so with the numbers.
          return reply.status(413).send({
            error: "File too large to serve",
            path: filePath,
            size: read.size,
            limit: BLOB_BUFFER_MAX,
          });
        case "error":
          return reply.status(500).send({ error: "Failed to read file content at this commit" });
      }

      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "public, max-age=3600")
        .send(read.buf);
    },
  );
}
