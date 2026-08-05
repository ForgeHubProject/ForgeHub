import { extname } from "node:path";
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import {
  git,
  readBlobAsBuffer,
  statBlob,
  openBlobStream,
  activeFormatsAtCommit,
  BLOB_BUFFER_MAX,
} from "../git-utils.js";
import type { BlobReadResult } from "../git-utils.js";
import {
  acquireRawblobStream,
  rawblobMaxBytes,
  rawblobStallTimeoutMs,
  RAWBLOB_RETRY_AFTER_SECONDS,
  RAWBLOB_SHARED_MAX_AGE_SECONDS,
} from "../rawblob-limits.js";
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
  // head blob to build its mesh), and by anyone who just wants the file.
  //
  // STREAMED, WITH NO SIZE CEILING (#157 phase 2). The shape is decide-then-pump:
  // one `cat-file --batch-check` pre-flight settles 404/413/304 and yields the
  // exact size *before a single header is written*, then git's stdout is piped
  // to the socket. Peak memory is one stream buffer, not one file — which is
  // precisely why an arbitrarily large blob can be served at all. If someone
  // could push it, they can fetch it back.
  //
  // HEAD is registered explicitly rather than via Fastify's exposeHeadRoute,
  // which would run this handler in full and throw the spawned stream away.
  app.route({
    method: ["GET", "HEAD"],
    url: "/repos/:handle/:name/rawblob",
    exposeHeadRoute: false,
    preHandler: [app.optionalAuthenticate],
    handler: async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { path: filePath, sha } = request.query as { path?: string; sha?: string };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!filePath || !sha) {
        return reply.status(400).send({ error: "'path' and 'sha' query params are required" });
      }
      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });
      const storageKey = repo.storageKey;
      if (!storageKey) return reply.status(404).send({ error: "Repository has no storage" });

      // Everything that can refuse the request happens here, while the headers
      // are still writable. Past this point the only way to signal failure is to
      // abort the socket, so nothing below is allowed to be a judgement call.
      const stat = await statBlob(storageKey, sha, filePath);
      if (stat.kind === "error") {
        return reply.status(500).send({ error: "Failed to read file content at this commit" });
      }
      // `missing` is a genuinely absent path; `not-blob` is a tree/tag/commit,
      // which is not file bytes and never was. (This route used to answer a
      // directory with 200 and a pretty-printed tree listing.)
      if (stat.kind !== "blob") {
        return reply.status(404).send({ error: "File not found at this commit" });
      }

      // There is no size limit by default. An operator may opt into one; when
      // they haven't, this branch does not exist.
      const maxBytes = rawblobMaxBytes();
      if (maxBytes !== null && stat.size > maxBytes) {
        return reply.status(413).send({
          error: "File too large to serve",
          path: filePath,
          size: stat.size,
          limit: maxBytes,
        });
      }

      // The blob oid is a perfect strong validator and costs nothing — it is
      // already in hand. (@fastify/etag would hash the body instead, which on a
      // multi-gigabyte blob is exactly the O(filesize) work streaming exists to
      // avoid.) The same unchanged file at many commits shares one ETag, so a
      // client re-fetching it across revisions gets 304s from different URLs.
      const etag = `"${stat.oid}"`;
      const isPublic = repo.visibility === "PUBLIC";
      const cacheControl = `${isPublic ? "public" : "private"}, ${
        // `immutable` is only truthful when the URL pins content. This route
        // resolves `sha` through git, so it also accepts a branch or tag name,
        // for which the same URL yields different bytes over time — those get
        // revalidation instead. (There is no separate ref-name variant of this
        // route; the two cases are the same URL shape, told apart here.)
        isCommitPinned(sha)
          ? // A commit-pinned URL's *bytes* never change, so a year and
            // `immutable` are honest — but the repo's *visibility* can change,
            // and a public→private flip must not leave a CDN serving the old
            // bytes for a year with revalidation suppressed. `s-maxage` bounds
            // only the shared copy; the browser cache that already has the
            // bytes keeps the full year. Private repos never reach a shared
            // cache in the first place, so they don't need it.
            `max-age=31536000${isPublic ? `, s-maxage=${RAWBLOB_SHARED_MAX_AGE_SECONDS}` : ""}, immutable`
          : "no-cache"
      }`;

      if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
        return reply.status(304).header("ETag", etag).header("Cache-Control", cacheControl).send();
      }

      const sendHeaders = () =>
        reply
          .header("Content-Type", "application/octet-stream")
          // Explicit, from the pre-flight: Fastify only derives Content-Length
          // for buffers, and a stream without one goes out chunked — leaving a
          // client unable to tell a truncated download from a complete one, or
          // to show progress. On a very large file that is the whole difference
          // between "downloading" and "hung".
          .header("Content-Length", String(stat.size))
          .header("ETag", etag)
          .header("Cache-Control", cacheControl)
          // Honest: git blobs are zlib-deflated with no random access, so the
          // origin cannot satisfy a Range. Saying `none` stops download managers
          // from attempting resumes that would silently restart.
          .header("Accept-Ranges", "none")
          .header("X-Content-Type-Options", "nosniff");

      if (request.method === "HEAD") return sendHeaders().send();

      // The one long-lived finite resource: each streaming response pins a
      // blocked git child for as long as the client keeps reading. This bounds
      // how many downloads run at once — it is NOT a size limit, and no file is
      // ever too big for it. Past the limit a request waits briefly for a slot
      // before being shed, so a burst costs latency rather than a failure.
      const release = await acquireRawblobStream();
      if (!release) {
        return reply
          .status(503)
          .header("Retry-After", String(RAWBLOB_RETRY_AFTER_SECONDS))
          .send({ error: "Too many concurrent downloads in flight; retry shortly" });
      }
      // The wait above can outlive the client. `close` has already fired on a
      // dead socket, so the cleanup registered below would never run — hand the
      // slot straight back instead of leaking it.
      if (reply.raw.destroyed) {
        release();
        reply.hijack();
        return reply;
      }

      const { child, stream } = openBlobStream(storageKey, stat.oid);
      child.once("close", release);
      // Fastify destroys the payload on disconnect and git dies on EPIPE, but
      // killing explicitly is deterministic and cheap — with no size ceiling, an
      // abandoned multi-gigabyte download must not leave a git process pinned.
      reply.raw.once("close", () => {
        child.kill();
        release();
      });
      sendHeaders();
      armStallTimeout(reply.raw, rawblobStallTimeoutMs(), () => {
        request.log.warn(
          { oid: stat.oid, path: filePath },
          "rawblob stream made no progress; dropping it and reclaiming the slot",
        );
      });
      return reply.send(stream);
    },
  });
}

/**
 * Drop a streaming response that stops making progress, so its concurrency slot
 * comes back without waiting for the client to disconnect.
 *
 * Concurrency is a *shared* limit, which makes "hold a slot and do nothing" an
 * attack: taking the headers and never reading the body costs the client no
 * bandwidth at all, and without this the slot is pinned until it chooses to go
 * away. Sixty-four such sockets would deny raw-blob downloads to everyone, for
 * as long as the attacker cared to keep them open.
 *
 * The mechanism is the socket's own idle timer, which is what makes this a
 * *stall* timeout and not a deadline: every byte that actually reaches the
 * client restarts it, so a transfer that is merely slow — a phone on a bad link
 * pulling a multi-gigabyte blob for an hour — is never interrupted, while one
 * that has moved nothing for `ms` is. Measured: a client reading 64 KiB every
 * 400 ms survives a 2 s window indefinitely; one reading nothing is dropped at
 * 2 s. `ms <= 0` disables it.
 */
function armStallTimeout(res: ServerResponse, ms: number, onStall: () => void) {
  const socket = res.socket;
  // No real socket, nothing to stall: in-process injection (light-my-request,
  // which hands back a plain Writable) has no peer that can stop reading, and
  // no `setTimeout` to arm.
  if (ms <= 0 || !socket || typeof socket.setTimeout !== "function") return;

  const previous = socket.timeout ?? 0;
  const handleStall = () => {
    onStall();
    // Destroying rather than ending: there is a promised Content-Length that
    // will not be met, and an abort is the only way to tell the client that.
    socket.destroy();
  };
  socket.setTimeout(ms);
  socket.once("timeout", handleStall);

  res.once("close", () => {
    socket.removeListener("timeout", handleStall);
    // Restore whatever governed the connection before (Fastify's keep-alive
    // timer, normally) so a reused connection is not left with our window — or
    // with none at all.
    if (!socket.destroyed) socket.setTimeout(previous);
  });
}

/** Does `sha` name an immutable object id (rather than a branch/tag that moves)? */
function isCommitPinned(sha: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha);
}

/**
 * RFC 9110 If-None-Match: a comma-separated list, `*`, or weak (`W/"…"`) forms.
 * Comparison is weak, which is what a conditional GET calls for.
 */
function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  return raw.split(",").some((candidate) => {
    const value = strip(candidate);
    return value === "*" || value === etag;
  });
}
