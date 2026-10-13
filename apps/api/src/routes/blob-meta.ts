import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { extname } from "node:path";
import { bareRepoPathFromKey } from "../git-storage.js";
import { activeFormatsAtCommit, blobSizeAtCommit, defaultBranch, resolveRefSha } from "../git-utils.js";
import { officialHandlerId } from "../fhr/official-handlers.js";
import { canRead, resolveRepo } from "../repo-access.js";

/** Bytes inspected for a NUL, as git does when it decides a file is binary. */
const BINARY_SNIFF = 8000;

/**
 * Whether a blob is binary: a NUL in its first 8000 bytes, git's own test.
 * Streams only those bytes, so a large model is never read whole.
 */
function isBinaryBlob(storageKey: string, sha: string, path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", `${sha}:${path}`], { cwd: bareRepoPathFromKey(storageKey) });
    let seen = 0;
    let done = false;
    const finish = (binary: boolean) => {
      if (done) return;
      done = true;
      child.kill();
      resolve(binary);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const look = chunk.subarray(0, BINARY_SNIFF - seen);
      if (look.includes(0)) return finish(true);
      seen += look.length;
      if (seen >= BINARY_SNIFF) finish(false);
    });
    child.on("error", (e) => { if (!done) { done = true; reject(e); } });
    child.on("close", (code) => {
      if (done) return;
      if (code !== 0) { done = true; return reject(new Error(`git cat-file exited with ${code}`)); }
      finish(false);
    });
  });
}

export async function blobMetaRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/blob-meta?ref=&path=  — what the file page's
  // header says about any file (#225), without downloading it: its size (from
  // the tree, so a 3D model's is known too), whether it's binary (git's test,
  // first 8000 bytes), and, when FHR's manifest has a handler for its
  // extension, which one and whether this repo has semantic diffs on for it
  // (its .forge/formats at that commit).
  app.get("/repos/:handle/:name/blob-meta", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { ref: refQ, path } = request.query as { ref?: string; path?: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    if (!path) return reply.status(400).send({ error: "'path' is required" });

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    const storageKey = repo.storageKey;
    if (!storageKey) return reply.status(404).send({ error: "No git storage" });

    const ref = refQ ?? (await defaultBranch(storageKey));
    if (!ref || ref.startsWith("-")) return reply.status(404).send({ error: "Ref not found" });
    const sha = await resolveRefSha(storageKey, ref);
    if (!sha) return reply.status(404).send({ error: "Ref not found" });
    const size = await blobSizeAtCommit(storageKey, sha, path);
    if (size === null) return reply.status(404).send({ error: "File not found" });

    const ext = extname(path).toLowerCase();
    let handlerId: string | null = null;
    try {
      handlerId = ext ? await officialHandlerId(ext) : null;
    } catch {
      handlerId = null; // manifest unreachable: the size still stands
    }
    const [semanticDiffs, binary] = await Promise.all([
      handlerId ? activeFormatsAtCommit(storageKey, sha).then((s) => s.has(ext)) : Promise.resolve(false),
      // Whether the file has a source view: a text file with a renderer gets
      // Preview | Code | Blame on its page (FHR#112).
      isBinaryBlob(storageKey, sha, path),
    ]);
    return { ref, sha, path, size, binary, format: handlerId ? { ext, handlerId, semanticDiffs } : null };
  });
}
