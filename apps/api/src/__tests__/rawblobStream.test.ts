/**
 * Streaming semantics of GET/HEAD /repos/:handle/:name/rawblob (#157 phase 2).
 *
 * The point of the route is that it has **no size ceiling**: bytes are piped
 * from `git cat-file blob <oid>` straight to the socket, so the file size the
 * server can serve is not bounded by the memory it is willing to hold. These
 * tests therefore use a fixture far past the 10 MiB the API will ever buffer,
 * and assert the body by digest — a prefix check would pass on a truncated
 * response, which is exactly the failure mode streaming introduces.
 *
 * The abort and concurrency cases need a real socket (light-my-request has no
 * connection to drop and no backpressure to apply), so this file listens on a
 * loopback port instead of using `app.inject`.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repoCollaborator: { findUnique: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { createTestRepo, type TestRepo } from "./helpers/git.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { openBlobStream } from "../git-utils.js";

const execFile = promisify(execFileCb);

/**
 * 26 MiB — comfortably past the 10 MiB in-memory ceiling this route used to
 * inherit, and past the renderer's own 32 MiB gate being the binding constraint.
 * The pattern walks every byte value (NUL and 0xFF included) and never repeats a
 * block, so a truncated or filtered body cannot match the digest by accident.
 */
const LARGE_BYTES = 26 * 1024 * 1024;

function largeFixture(): Buffer {
  const buf = Buffer.allocUnsafe(LARGE_BYTES);
  for (let i = 0; i < LARGE_BYTES; i++) buf[i] = (i * 7 + (i >>> 13)) & 0xff;
  return buf;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let repo: TestRepo;
let app: FastifyInstance;
let origin: string;
let headSha: string;
let branch: string;
let bigOid: string;
let big: Buffer;

const MOCK_REPO = {
  id: "repo-1",
  name: "assets",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
} as const;

beforeAll(async () => {
  repo = await createTestRepo("test/rawblob-stream.git");
  big = largeFixture();
  // `-text` guarantees git applies no eol conversion, so "byte-identical" is a
  // claim about the route and not about the fixture's luck.
  await writeFile(join(repo.workDir, ".gitattributes"), "* -text\n");
  await writeFile(join(repo.workDir, "big.bin"), big);
  await writeFile(join(repo.workDir, "small.txt"), "hello\n");
  await mkdir(join(repo.workDir, "sub"), { recursive: true });
  await writeFile(join(repo.workDir, "sub", "nested.txt"), "nested\n");
  const git = (...args: string[]) => execFile("git", ["-C", repo.workDir, ...args]);
  await git("add", "-A");
  await git("commit", "-m", "add a large binary asset");
  await git("push", "origin", "HEAD");
  headSha = (await git("rev-parse", "HEAD")).stdout.trim();
  branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
  bigOid = (await git("rev-parse", `HEAD:big.bin`)).stdout.trim();

  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
  app = await createTestServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await repo.cleanup();
});

beforeEach(async () => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  delete process.env["FORGEHUB_RAWBLOB_MAX_BYTES"];
  // The route keeps no counters, so the honest quiescence check is the resource
  // itself: every git child from the previous case must be gone. A leaked child
  // fails the next test rather than being papered over.
  expect(await waitFor(async () => (await catFileProcesses(bigOid)) === 0)).toBe(true);
});

function url(path: string, sha: string) {
  return `${origin}/repos/alice/assets/rawblob?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`;
}

/** Issue a request and resolve as soon as the response headers arrive. */
function open(
  target: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ res: IncomingMessage; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      target,
      { method: opts.method ?? "GET", headers: opts.headers, agent: false },
      (res) => resolve({ res, abort: () => req.destroy() }),
    );
    req.on("error", reject);
    req.end();
  });
}

/** Read a response to completion and return the exact bytes. */
function drain(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

/** Read a response to its end, recording how it terminated rather than throwing. */
function readOutcome(res: IncomingMessage): Promise<{ bytes: number; error: Error | null }> {
  return new Promise((resolve) => {
    let bytes = 0;
    res.on("data", (c: Buffer) => { bytes += c.length; });
    res.on("end", () => resolve({ bytes, error: null }));
    res.on("error", (error) => resolve({ bytes, error }));
    res.on("aborted", () => resolve({ bytes, error: new Error("aborted") }));
  });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** How many `git cat-file blob <oid>` children are alive right now. */
async function catFileProcesses(oid: string): Promise<number> {
  try {
    const { stdout } = await execFile("pgrep", ["-fc", `cat-file blob ${oid}`]);
    return Number(stdout.trim());
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

describe("GET /rawblob — streamed, no size ceiling", () => {
  it("serves a 26 MiB blob with an exact Content-Length and a byte-identical body", async () => {
    const { res } = await open(url("big.bin", headSha));
    const body = await drain(res);

    expect(res.statusCode).toBe(200);
    // Explicit Content-Length, not chunked — a client can detect truncation.
    expect(res.headers["content-length"]).toBe(String(LARGE_BYTES));
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(body.length).toBe(LARGE_BYTES);
    // Digest, not a prefix: a short read is precisely what streaming risks.
    expect(sha256(body)).toBe(sha256(big));
  }, 60_000);

  it("carries the blob oid as a strong ETag and immutable caching for a commit-pinned URL", async () => {
    const { res } = await open(url("small.txt", headSha));
    await drain(res);
    expect(res.headers["etag"]).toBe(`"${await smallOid()}"`);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, s-maxage=600, immutable");
    expect(res.headers["accept-ranges"]).toBe("none");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    // A raw byte route must never hand a cache a credential to key on.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("does NOT claim immutability when the URL names a ref instead of a commit", async () => {
    // The same URL shape accepts a branch name, and a branch moves — so the
    // bytes behind that URL can change and `immutable` would be a lie. The oid
    // ETag still makes revalidation a 304.
    const { res } = await open(url("small.txt", branch));
    await drain(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, no-cache");
    expect(res.headers["etag"]).toBe(`"${await smallOid()}"`);
  });

  it("marks a private repo's bytes private so no shared cache stores them", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const { res } = await open(url("small.txt", headSha), {
      headers: { authorization: await authHeader(app, "user-1") },
    });
    await drain(res);
    expect(res.statusCode).toBe(200);
    // No `s-maxage`: a shared cache is told not to store this at all, so
    // bounding how long it may keep it would be meaningless.
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  });

  it("bounds how long a SHARED cache may hold a public blob, so a visibility flip is not a year-long leak", async () => {
    // `immutable` + a year is honest about the *bytes* — a commit-pinned URL's
    // content can never change — but says nothing about who may read them, and
    // a repo can be flipped PUBLIC→PRIVATE. Without an `s-maxage`, a CDN would
    // keep serving the old bytes for a year and `immutable` would suppress the
    // revalidation that caught it. The browser cache belongs to someone who
    // already had the bytes, so it keeps the full year.
    const { res } = await open(url("small.txt", headSha));
    await drain(res);
    const cc = res.headers["cache-control"] ?? "";
    expect(cc).toContain("max-age=31536000");
    const shared = /(?:^|[ ,])s-maxage=(\d+)/.exec(cc);
    expect(shared).not.toBeNull();
    expect(Number(shared?.[1])).toBeLessThanOrEqual(3600);
  });

  it("answers 304 to If-None-Match with the blob oid, without re-reading the blob", async () => {
    const { res } = await open(url("big.bin", headSha), {
      headers: { "if-none-match": `"${bigOid}"` },
    });
    const body = await drain(res);
    expect(res.statusCode).toBe(304);
    expect(body.length).toBe(0);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["etag"]).toBe(`"${bigOid}"`);
    // Nothing was spawned to produce a 304.
    expect(await catFileProcesses(bigOid)).toBe(0);
  });

  it("honours a weak/list-form If-None-Match", async () => {
    const { res } = await open(url("big.bin", headSha), {
      headers: { "if-none-match": `"deadbeef", W/"${bigOid}"` },
    });
    await drain(res);
    expect(res.statusCode).toBe(304);
  });

  it("answers HEAD with the full headers and no stream at all", async () => {
    const { res } = await open(url("big.bin", headSha), { method: "HEAD" });
    const body = await drain(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(LARGE_BYTES));
    expect(res.headers["etag"]).toBe(`"${bigOid}"`);
    expect(body.length).toBe(0);
    // A HEAD must not spawn-then-discard a 26 MiB read.
    expect(await catFileProcesses(bigOid)).toBe(0);
  });

  it("still 404s a directory rather than serving a tree listing (#157 phase 1 regression)", async () => {
    const { res } = await open(url("sub", headSha));
    const body = await drain(res);
    expect(res.statusCode).toBe(404);
    expect(body.toString()).not.toContain("nested.txt");
  });

  it("a mid-stream git death reaches the client as a failed transfer, not a short 200", async () => {
    // End-to-end backstop, NOT the regression test for the EOF-gating trap: it
    // passes on the strength of the explicit Content-Length alone (verified by
    // mutation — remove the gating and this still goes green, because Node's
    // client reports a body shorter than the promised length as an abort). It
    // is here because "the client can tell" is the property that actually
    // matters at the HTTP layer, and it is worth pinning independently.
    //
    // The gating itself — the thing that saves a consumer with no
    // Content-Length to check — is pinned by the two `openBlobStream` unit
    // tests below, which is where the discriminating coverage lives.
    const { res } = await open(url("big.bin", headSha));
    expect(res.statusCode).toBe(200);
    await new Promise<void>((resolve) => res.once("data", () => resolve()));
    await execFile("pkill", ["-f", `cat-file blob ${bigOid}`]).catch(() => undefined);

    const outcome = await readOutcome(res);
    expect(outcome.bytes).toBeLessThan(LARGE_BYTES);
    expect(outcome.error).not.toBeNull();
  }, 30_000);

  it("openBlobStream turns a non-zero git exit into a stdout error, not a silent EOF", async () => {
    // The discriminating test for the trap: an oid git cannot read makes it exit
    // 128 having written nothing. Left alone, stdout would simply end — a
    // consumer piping it sees a successful empty read. It must error instead.
    const { stream } = openBlobStream(repo.storageKey, "0".repeat(40));
    const outcome = await new Promise<{ ended: boolean; error: Error | null }>((resolve) => {
      stream.resume();
      stream.on("end", () => resolve({ ended: true, error: null }));
      stream.on("error", (error) => resolve({ ended: false, error }));
    });
    expect(outcome.ended).toBe(false);
    expect(outcome.error).not.toBeNull();
    expect(String(outcome.error)).toMatch(/git cat-file exited/);
  });

  it("openBlobStream errors even when git dies AFTER delivering bytes and stdout EOFs first", async () => {
    // The other half of the trap, and the one the gating exists for: when git
    // has already written a prefix, stdout's `end` and the child's `exit` race,
    // and `end` usually wins. A naive implementation ends the relay right there
    // — a consumer sees a clean EOF after a partial file and no error anywhere.
    // Bytes must have flowed AND the stream must still error.
    const { child, stream } = openBlobStream(repo.storageKey, bigOid);
    let bytes = 0;
    const outcome = await new Promise<{ ended: boolean; error: Error | null }>((resolve) => {
      stream.on("data", (c: Buffer) => {
        bytes += c.length;
        // Kill only once we are provably mid-body, so this is the
        // wrote-then-failed case and not the wrote-nothing one above.
        if (bytes > 0) child.kill("SIGKILL");
      });
      stream.on("end", () => resolve({ ended: true, error: null }));
      stream.on("error", (error) => resolve({ ended: false, error }));
    });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(LARGE_BYTES);
    expect(outcome.ended).toBe(false);
    expect(outcome.error).not.toBeNull();
  }, 30_000);

  it("openBlobStream still ends cleanly on success — the gating must not break the happy path", async () => {
    // The counterweight: a rule that turns every EOF into an error would pass
    // both tests above and serve nothing. A whole small blob must arrive and
    // the stream must end, not error.
    const { stream } = openBlobStream(repo.storageKey, await smallOid());
    const outcome = await new Promise<{ ended: boolean; error: Error | null; body: string }>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () =>
        resolve({ ended: true, error: null, body: Buffer.concat(chunks).toString() }));
      stream.on("error", (error) => resolve({ ended: false, error, body: "" }));
    });
    expect(outcome.error).toBeNull();
    expect(outcome.ended).toBe(true);
    expect(outcome.body).toBe("hello\n");
  });

  it("leaves no git process behind when the client disappears mid-stream", async () => {
    const { res, abort } = await open(url("big.bin", headSha));
    expect(res.statusCode).toBe(200);
    // Take one chunk so we are provably mid-body, then vanish.
    await new Promise<void>((resolve) => res.once("data", () => resolve()));
    // The child really is running and really is ours to clean up.
    expect(await catFileProcesses(bigOid)).toBeGreaterThan(0);
    abort();

    // Deliberately no assertion on how git dies — EPIPE vs SIGPIPE vs SIGTERM
    // is platform-dependent. What matters is that nothing is left running.
    expect(await waitFor(async () => (await catFileProcesses(bigOid)) === 0)).toBe(true);
  }, 30_000);
});

/**
 * A GET issued over a RAW SOCKET and read at a byte rate we actually control.
 *
 * `http.request` cannot be used for this. Its client buffers a response
 * independently of how fast the test consumes it, and an `http.Agent` detaches
 * the socket the moment the response ends — so neither the transfer rate nor the
 * connection's fate is observable through it. Here the socket is paused and
 * exactly `bytesPerSecond` is taken out of it per second, so the rate the server
 * sees is the rate this test asked for.
 *
 * `serverClosed` reports what the SERVER did: whether the connection went away
 * before we chose to stop reading.
 */
async function readAtRate(
  target: string,
  opts: { bytesPerSecond: number; durationMs: number },
): Promise<{ status: number; bodyBytes: number; serverClosed: boolean; childAlive: boolean }> {
  const TICK_MS = 250;
  const perTick = Math.max(1, Math.round((opts.bytesPerSecond * TICK_MS) / 1000));
  const u = new URL(target);

  const outcome = await new Promise<{
    status: number;
    bodyBytes: number;
    serverClosed: boolean;
    childAlive: boolean;
  }>((resolve) => {
      // A tiny read buffer so backpressure reaches the server almost at once
      // instead of hiding behind the client's own queue.
      const sock = netConnect({ host: u.hostname, port: Number(u.port), highWaterMark: perTick });
      let status = 0;
      let bodyBytes = 0;
      let header = Buffer.alloc(0);
      let settled = false;
      const finish = (serverClosed: boolean, childAlive = false) => {
        if (settled) return;
        settled = true;
        resolve({ status, bodyBytes, serverClosed, childAlive });
      };
      // Any of these means the connection is gone and we did not end it.
      sock.on("error", () => finish(true));
      sock.on("end", () => finish(true));
      sock.on("close", () => finish(true));

      sock.on("connect", () => {
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`,
        );
        sock.pause();

        // Headers first, at whatever speed they arrive — throttling starts with
        // the body, which is the part whose rate this test is about.
        const readHeaders = () => {
          let chunk: Buffer | null;
          while ((chunk = sock.read() as Buffer | null) !== null) {
            header = Buffer.concat([header, chunk]);
            const end = header.indexOf("\r\n\r\n");
            if (end < 0) continue;
            status = Number(/^HTTP\/1\.\d (\d{3})/.exec(header.subarray(0, end).toString())?.[1] ?? 0);
            bodyBytes += header.length - (end + 4);
            sock.removeListener("readable", readHeaders);
            const started = Date.now();
            const tick = () => {
              if (settled) return;
              // At most `perTick` bytes per tick, and never more.
              const got = (sock.read(perTick) ?? sock.read()) as Buffer | null;
              if (got) bodyBytes += got.length;
              if (Date.now() - started >= opts.durationMs) {
                // Sample the child BEFORE hanging up: closing this socket is
                // itself what kills it, so measuring afterwards would race with
                // our own teardown and read as "the server dropped us".
                void catFileProcesses(bigOid).then((n) => {
                  finish(false, n > 0);
                  sock.destroy();
                });
                return;
              }
              setTimeout(tick, TICK_MS);
            };
            setTimeout(tick, TICK_MS);
            return;
          }
        };
        sock.on("readable", readHeaders);
      });
  });

  // The route kills its git child whenever the response closes, so a child still
  // running while we are still reading is proof the server never dropped us.
  return outcome;
}

/**
 * Milliseconds between a keep-alive response arriving in full and the SERVER
 * closing the idle connection, or `Infinity` if it never does within `capMs`.
 *
 * Raw socket again, and for the same reason: an `http.Agent` takes the socket
 * away at `end`, so a leaked connection is invisible through it. This client
 * never closes anything — every close observed here is the server's.
 */
function keepAliveReapDelay(target: string, capMs = 8_000): Promise<number> {
  const u = new URL(target);
  return new Promise((resolve) => {
    const sock = netConnect({ host: u.hostname, port: Number(u.port) });
    let seen = Buffer.alloc(0);
    let completeAt = 0;
    sock.on("connect", () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: keep-alive\r\n\r\n`,
      );
    });
    sock.on("data", (d: Buffer) => {
      seen = Buffer.concat([seen, d]);
      const end = seen.indexOf("\r\n\r\n");
      if (completeAt || end < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(seen.subarray(0, end).toString())?.[1] ?? 0);
      if (seen.length - (end + 4) >= length) completeAt = Date.now();
    });
    const cap = setTimeout(() => {
      sock.destroy();
      resolve(Infinity);
    }, capMs);
    sock.on("close", () => {
      clearTimeout(cap);
      resolve(completeAt ? Date.now() - completeAt : Infinity);
    });
    sock.on("error", () => undefined);
  });
}

describe("GET /rawblob — nothing may function as a size ceiling", () => {
  it("never drops a download that is slow but making progress, however slow", async () => {
    // THE REQUIREMENT: raw blobs stream with no size ceiling, and no mechanism
    // may function as one. A timeout that kills a slow-but-progressing transfer
    // IS a size ceiling for slow links — below some byte rate a large file can
    // never be fetched, every retry dies at the same offset, and
    // `Accept-Ranges: none` means it cannot be resumed.
    //
    // The route this replaced had a socket-idle "stall timeout" that could not
    // tell 8 KiB/s from 0 B/s: Node resets that timer on write dispatch, and
    // under backpressure a dispatch waits on the peer draining everything
    // buffered downstream. Measured on that revision: 8 and 16 KiB/s dropped,
    // 32 KiB/s survived. The legacy knob is set here so that a mechanism of that
    // shape coming back — under that name, or honouring it — is caught in
    // seconds rather than needing a 30 s window. It is inert in shipped code:
    // nothing reads it, which the rawblobLimits suite asserts separately.
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "3000";
    try {
      const RATE = 8 * 1024;
      const DURATION = 15_000;
      const outcome = await readAtRate(url("big.bin", headSha), {
        bytesPerSecond: RATE,
        durationMs: DURATION,
      });

      expect(outcome.status).toBe(200);
      // The rate really was ~8 KiB/s, five stall windows long. This is not a
      // fast client in disguise, and it is not a short one.
      expect(outcome.bodyBytes).toBeGreaterThan((RATE * DURATION) / 1000 / 2);
      expect(outcome.bodyBytes).toBeLessThan(RATE * 2 * (DURATION / 1000));
      // The two server-side assertions, which is the whole point: a client that
      // merely sees no error proves nothing, because ~1 MB stays buffered
      // between the two ends and keeps arriving long after a drop.
      expect(outcome.serverClosed).toBe(false);
      expect(outcome.childAlive).toBe(true);
    } finally {
      delete process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"];
    }
  }, 60_000);

  it("does not disarm the connection reaper, so one rawblob GET cannot leak a socket", async () => {
    // REGRESSION, and API-wide rather than rawblob-shaped. Arming a socket idle
    // timeout for the stream captured `socket.timeout` first — 0, because
    // Fastify's server.timeout is 0 — and restored it when the response closed.
    // Node arms `socket.setTimeout(keepAliveTimeout)` from its own `finish`
    // handler, which runs BEFORE the response's `close`, so restoring 0
    // cancelled it. Any client could then pin N sockets and file descriptors
    // forever by issuing one tiny /rawblob GET on each, at zero cost — and
    // headersTimeout does not reap those (no request is in flight).
    //
    // keepAliveTimeout is lowered so "reaped" is observable; /health is the
    // control, and the streamed route must behave the same.
    const previousKeepAlive = app.server.keepAliveTimeout;
    app.server.keepAliveTimeout = 1_000;
    try {
      const control = await keepAliveReapDelay(`${origin}/health`);
      const streamed = await keepAliveReapDelay(url("small.txt", headSha));
      expect(control).toBeLessThan(5_000);
      expect(streamed).toBeLessThan(5_000);
      // Same clock, not merely "closed eventually".
      expect(Math.abs(streamed - control)).toBeLessThan(2_000);
    } finally {
      app.server.keepAliveTimeout = previousKeepAlive;
    }
  }, 60_000);

  it("lets clients that take the headers and never read deny nothing to anyone else", async () => {
    // REGRESSION. The route used to hold one of 64 GLOBAL slots per in-flight
    // download, so 64 sockets that took the headers and read nothing — costing
    // the attacker no bandwidth at all — refused /rawblob to everybody. Adding a
    // timer that reclaimed those slots only changed the price from "hold a
    // socket" to "reconnect every 30 s", which is still about zero.
    //
    // There is no shared pool now, so these holders bound only themselves. 65 is
    // one past the pool that used to exist, which is what makes this fail if a
    // semaphore comes back at that default.
    const HOLDERS = 65;
    const holders = await Promise.all(
      Array.from({ length: HOLDERS }, () => open(url("big.bin", headSha))),
    );
    try {
      for (const h of holders) {
        expect(h.res.statusCode).toBe(200);
        // Deliberately never read: left paused, and never disconnected.
        h.res.on("error", () => undefined);
      }
      expect(await catFileProcesses(bigOid)).toBeGreaterThanOrEqual(HOLDERS);

      // A different client, with all 65 still connected and still reading
      // nothing. It must be served, and served promptly — no 503, no queueing.
      const started = Date.now();
      const served = await open(url("small.txt", headSha));
      const body = await drain(served.res);
      expect(served.res.statusCode).toBe(200);
      expect(body.toString()).toBe("hello\n");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const h of holders) h.abort();
    }
    // And nothing is leaked once they do go away.
    expect(await waitFor(async () => (await catFileProcesses(bigOid)) === 0)).toBe(true);
  }, 120_000);

  it("applies an operator's opt-in byte ceiling only when one is configured", async () => {
    // Unset by default: the 26 MiB blob is served, no ceiling anywhere.
    const unlimited = await open(url("big.bin", headSha), { method: "HEAD" });
    await drain(unlimited.res);
    expect(unlimited.res.statusCode).toBe(200);

    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = String(1024);
    const capped = await open(url("big.bin", headSha));
    const body = await drain(capped.res);
    expect(capped.res.statusCode).toBe(413);
    const json = JSON.parse(body.toString());
    expect(json.size).toBe(LARGE_BYTES);
    expect(json.limit).toBe(1024);
  }, 30_000);
});

/** The blob oid of `small.txt` at the fixture commit. */
async function smallOid(): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repo.workDir, "rev-parse", "HEAD:small.txt"]);
  return stdout.trim();
}
