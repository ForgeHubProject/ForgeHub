import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import {
  git,
  readBlobAsBuffer,
  statBlob,
  openBlobStream,
  activeFormatsAtCommit,
  DIFF_BUFFER_MAX,
} from "../git-utils.js";
import type { BlobReadResult } from "../git-utils.js";
import { rawblobMaxBytes, RAWBLOB_SHARED_MAX_AGE_SECONDS } from "../rawblob-limits.js";
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

      // Order matters, and it runs most-fundamental-first: a request that was
      // never well-formed cannot also be "too large", and a git that blew up
      // never established a size to compare. Answering 413 to a malformed
      // request whose *other* side happens to be over the cap would report a
      // limit as the reason a typo failed.
      //
      // A malformed request (a NUL in the path) is the client's, not ours.
      if (headRead.kind === "invalid" || baseRead.kind === "invalid") {
        return reply.status(400).send({ error: "Invalid 'path' or 'sha'" });
      }
      if (headRead.kind === "error" || baseRead.kind === "error") {
        return reply.status(500).send({ error: "Failed to read file content at this commit" });
      }
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
          limit: DIFF_BUFFER_MAX,
        });
      }
      // A tree at the head path is not a file, and this route has known that
      // since the pre-flight — it just used to throw the answer away. Left
      // alone, a directory falls through as an empty head blob and the diff
      // reports the file as DELETED: a second untrue statement assembled out of
      // the same information /rawblob already answers honestly with a 404.
      if (headRead.kind === "not-blob") {
        return reply.status(404).send({ error: "Path is not a file at this commit", path: filePath });
      }
      // A tree at the *base* path where head is a real file is not a lie: the
      // file genuinely did not exist at that path before, so an empty base — an
      // "added" diff — is the honest reading, same as a missing base.
      //
      // Only a genuinely absent path reaches the 404 now. An added file still
      // has a missing base and diffs against empty bytes, exactly as before.
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
  // Binary-safe, unlike the utf-8 /blob endpoints.
  //
  // There is deliberately NO size limit here by default. A contributor who can
  // push an arbitrarily large file has to be able to fetch it back; someone who
  // commits a huge asset is accepting the cost of their own connection, not
  // asking the server to decide for them. That is affordable because the
  // response is streamed straight off `git cat-file blob`: memory is
  // O(highWaterMark) per request rather than O(filesize), so there is no
  // resource for a ceiling to protect. (An operator may still opt into one —
  // see rawblob-limits.ts — but nothing is imposed on them.)
  //
  // The shape is decide-then-pump: one `cat-file --batch-check` pre-flight
  // settles 400/404/413/304 and yields the exact size *before a single header
  // is written*, then git's stdout is piped to the socket. Past that point the
  // only way to signal failure is to abort the connection, so nothing below the
  // pre-flight is allowed to be a judgement call.
  //
  // HEAD is registered explicitly rather than via Fastify's exposeHeadRoute,
  // which would run this handler in full and throw a spawned git child away.
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
      switch (stat.kind) {
        case "missing":
        // A tree/tag/commit at that path is not file bytes, and this route only
        // hands over file bytes. (It used to answer a directory with 200 and a
        // pretty-printed tree listing, because `git show <sha>:<dir>` exits 0.)
        case "not-blob":
          return reply.status(404).send({ error: "File not found at this commit" });
        case "invalid":
          // The request itself can't be formed — a NUL in the path. That is the
          // caller's bug, and 400 says so rather than blaming the repository.
          return reply.status(400).send({ error: "Invalid 'path' or 'sha'" });
        case "error":
          return reply.status(500).send({ error: "Failed to read file content at this commit" });
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
      // already in hand from the pre-flight. (@fastify/etag would hash the body
      // instead, which on a multi-gigabyte blob is exactly the O(filesize) work
      // streaming exists to avoid.) The same unchanged file at many commits
      // shares one ETag, so a client re-fetching it across revisions gets 304s
      // from different URLs.
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

      // Answered from the pre-flight alone: a validated 304 must not cost a git
      // child, which is the entire point of using the oid as the validator.
      if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
        return reply.status(304).header("ETag", etag).header("Cache-Control", cacheControl).send();
      }

      const sendHeaders = () =>
        reply
          .header("Content-Type", "application/octet-stream")
          // Content-Length comes from the pre-flight, not from a buffer:
          // Fastify only computes it for Buffers, and without it the response
          // goes chunked and a client cannot tell a truncated download from a
          // complete one, or show progress. On a very large file that is the
          // whole difference between "downloading" and "hung".
          .header("Content-Length", String(stat.size))
          .header("ETag", etag)
          .header("Cache-Control", cacheControl)
          // Honest: git blobs are zlib-deflated with no random access, so the
          // origin cannot satisfy a Range. Saying `none` stops download managers
          // from attempting resumes that would silently restart.
          .header("Accept-Ranges", "none")
          .header("X-Content-Type-Options", "nosniff");

      // The whole HEAD answer is already in hand. Returning here is what keeps
      // a HEAD from spawning a git child only to throw its output away.
      if (request.method === "HEAD") return sendHeaders().send();

      // Nothing below counts, paces, times or bounds this transfer, and nothing
      // is allowed to: a download that is making progress is never interrupted
      // *by this process*, however slow it is and however large the blob,
      // because there is no mechanism here that could interrupt it. (The proxy
      // in front is not equally free of them — nginx's `send_timeout` imposes a
      // sub-KiB/s rate floor, documented in apps/web/nginx.conf. That is not a
      // reason to add anything here.) In particular this code MUST NOT
      // call `socket.setTimeout`. Doing so cancels the `keepAliveTimeout` that
      // Node arms from its own `finish` handler and leaks the connection reaper
      // API-wide; and a socket idle timer cannot distinguish a slow reader from
      // a stalled one anyway, because under backpressure it is reset on write
      // dispatch rather than on bytes leaving the host. `rawblob-limits.ts`
      // records both findings and what bounds the route instead (nginx's
      // per-client `limit_conn`, Node's own connection reaping, TCP
      // backpressure).
      //
      // If git dies mid-stream its stdout just EOFs, so Fastify ends the body
      // short of the Content-Length above and the socket then sits there,
      // looking like a download still in flight, until an unrelated keep-alive
      // timeout reaps it (72s under Fastify's default). Content-Length is what
      // makes the truncation *detectable*; cutting the connection is what makes
      // it detectable NOW instead of a minute and a bit later.
      //
      // It has to be the SOCKET, not `reply.raw`. Node detaches the socket from
      // the response the instant a body is ended — short or not — after which
      // `reply.raw.destroy()` finds `res.socket === null` and does nothing at
      // all. That is the very same lose-the-race-with-EOF bug as destroying
      // git's stdout, one layer up, and a fast consumer loses it every time.
      // Capturing the socket up front sidesteps the whole lifecycle question.
      //
      // NB: this is an abort, not a size or time limit. Nothing here reacts to
      // how big the blob is or how long the transfer takes — only to git itself
      // failing. A slow client stays served for as long as it keeps reading.
      const socket = reply.raw.socket;
      const child = openBlobStream(storageKey, stat.oid, () => {
        // A HEAD cannot reach this line any more — it is answered above without
        // ever spawning a child. The guard stays because the failure it names is
        // real and cheap to keep out: a HEAD finishes long before a large blob
        // has drained, so the kill-on-close below lands on a still-running child
        // and reports a failure here, where tearing down the connection would
        // kill a perfectly good keep-alive socket. Measured over one reused
        // socket, every second HEAD came back ECONNRESET without it.
        if (request.method === "HEAD") return;
        // On a GET, `cat-file blob` exits 0 only after handing over the whole
        // object, so a failure means the body on the wire is short and this
        // connection has nothing left to say. (The success path cannot reach
        // here: the child is already gone with status 0 by the time Fastify
        // finishes the body, so killing it on close is a no-op.)
        reply.raw.destroy();
        socket?.destroy();
      });
      // Fastify destroys the payload on disconnect and git dies on EPIPE, but
      // killing explicitly is deterministic and cheap — with no size ceiling, an
      // abandoned multi-gigabyte download must not leave a git process pinned.
      // This fires on normal completion too, where it is a no-op on an already
      // exited child.
      reply.raw.once("close", () => child.kill());
      sendHeaders();
      return reply.send(child.stdout);
    },
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
