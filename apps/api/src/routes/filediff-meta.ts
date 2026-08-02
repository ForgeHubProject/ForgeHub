import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { git, activeFormatsAtCommit, handlerPinsAtCommit, blobSizeAtCommit } from "../git-utils.js";
import { officialHandlerId } from "../fhr/official-handlers.js";
import { handlerBuild, handlerWasmUrl } from "../fhr/manifest.js";

// Compute-tier metadata for one file at a commit, WITHOUT computing the diff
// (issue #66 P4). This is everything the web app needs to decide which tier to
// offer and to be honest about what each costs (SPEC-RENDERING §4–§5):
//
//   - the blob SHAs + byte sizes → Tier B's download-cost disclosure and the
//     Tier L `forge diff --web <path> <base>..<head>` hand-off command
//   - whether the manifest declares a wasm build → Tier B capability detection
//   - the manifest's current build vs. the repo's `.forge/handlers` pin →
//     surfacing build skew loudly instead of silently rendering a diff a
//     different build produced
//
// Gating mirrors /filediff exactly (repo opt-in AND an official handler), so a
// 404 here means the same thing it means there: the file has no semantic
// support and the UI shows its plain viewer with no tier machinery at all.
export async function fileDiffMetaRoutes(app: FastifyInstance) {
  app.get(
    "/repos/:handle/:name/filediff-meta",
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

      // Same semantic gate as /filediff: manifest-official handler AND repo
      // opt-in. No format knowledge lives here (#74).
      const activeExts = await activeFormatsAtCommit(storageKey, sha);
      const ext = extname(filePath).toLowerCase();
      let handlerId: string | null;
      try {
        handlerId = await officialHandlerId(ext);
      } catch {
        return reply.status(503).send({ error: "FHR manifest unavailable" });
      }
      if (!activeExts.has(ext) || !handlerId) {
        return reply.status(404).send({ error: "No semantic handler for this file" });
      }

      // Base defaults to the commit's first parent, exactly like /filediff, so
      // the SHAs here name the same blob pair the server diff would use.
      let baseSha = base;
      if (!baseSha) {
        try {
          baseSha = await git(storageKey, ["rev-parse", `${sha}^`]);
        } catch {
          baseSha = undefined;
        }
      }

      const [baseSize, headSize, pins, wasmUrl, officialBuild] = await Promise.all([
        baseSha ? blobSizeAtCommit(storageKey, baseSha, filePath) : Promise.resolve(null),
        blobSizeAtCommit(storageKey, sha, filePath),
        handlerPinsAtCommit(storageKey, sha),
        // Manifest lookups can't reject here: officialHandlerId above already
        // proved a manifest is cached.
        handlerWasmUrl(handlerId),
        handlerBuild(handlerId),
      ]);

      return {
        handlerId,
        path: filePath,
        baseSha: baseSha ?? null,
        headSha: sha,
        baseSize,
        headSize,
        // Capability, not location: the client computes through the /handlers
        // proxy, so all it needs to know is whether a build exists (or a
        // self-hosting override serves one).
        wasmAvailable: Boolean(process.env["FHR_WASM_BASE"]) || wasmUrl !== null,
        officialBuild,
        // null when the repo pins nothing for this handler (no lockfile, or an
        // explicit unpinned `null` entry — indistinguishable on purpose: both
        // mean "run whatever the manifest currently serves").
        pinnedBuild: pins.get(handlerId) ?? null,
      };
    },
  );
}
