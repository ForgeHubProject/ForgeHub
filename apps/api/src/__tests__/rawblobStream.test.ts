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
import { activeRawblobStreams, queuedRawblobStreams } from "../rawblob-limits.js";
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
  delete process.env["FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS"];
  delete process.env["FORGEHUB_RAWBLOB_MAX_BYTES"];
  delete process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"];
  delete process.env["FORGEHUB_RAWBLOB_QUEUE_WAIT_MS"];
  // No test-only counter reset: a slot the previous case dropped must come back
  // on its own, or the semaphore leaks in production too.
  expect(await waitFor(() => activeRawblobStreams() === 0)).toBe(true);
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
    expect(activeRawblobStreams()).toBe(0);
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
    expect(activeRawblobStreams()).toBe(0);
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
    // is platform-dependent. What matters is that nothing is left running and
    // the slot is handed back.
    expect(await waitFor(async () => (await catFileProcesses(bigOid)) === 0)).toBe(true);
    expect(await waitFor(() => activeRawblobStreams() === 0)).toBe(true);
  }, 30_000);
});

describe("GET /rawblob — concurrency limit (a download count, not a size limit)", () => {
  it("sheds with 503 + Retry-After past the limit, and recovers when a slot frees", async () => {
    process.env["FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS"] = "1";
    // No queue and no reclamation here — this pins the shed itself, with the
    // two mechanisms that soften it covered separately below.
    process.env["FORGEHUB_RAWBLOB_QUEUE_WAIT_MS"] = "0";
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "0";

    // Hold a slot: take the headers but never read the body, so git blocks on
    // backpressure and the response stays in flight.
    const first = await open(url("big.bin", headSha));
    expect(first.res.statusCode).toBe(200);
    expect(await waitFor(() => activeRawblobStreams() === 1)).toBe(true);

    const second = await open(url("big.bin", headSha));
    const body = await drain(second.res);
    expect(second.res.statusCode).toBe(503);
    expect(second.res.headers["retry-after"]).toBe("5");
    expect(JSON.parse(body.toString()).error).toMatch(/concurrent/i);

    // Free the slot and the very next request is served again.
    first.abort();
    expect(await waitFor(() => activeRawblobStreams() === 0)).toBe(true);

    const third = await open(url("small.txt", headSha));
    const served = await drain(third.res);
    expect(third.res.statusCode).toBe(200);
    expect(served.toString()).toBe("hello\n");
  }, 60_000);

  it("reclaims slots from clients that hold a response open without reading it", async () => {
    // REGRESSION: a slot used to be held for the connection's lifetime, so a
    // client that took the headers and then read nothing pinned its git child
    // forever — free to mount (no bandwidth spent) and unrecoverable without an
    // operator killing sockets. Filling the pool that way denied /rawblob to
    // everyone for as long as the attacker cared to keep the sockets open.
    //
    // The slot is now held only while the transfer makes progress, so the pool
    // clears itself. The holders are kept referenced and un-read for the whole
    // test: nothing here disconnects them.
    process.env["FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS"] = "2";
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "1500";
    process.env["FORGEHUB_RAWBLOB_QUEUE_WAIT_MS"] = "0"; // isolate reclamation from queueing

    const holders = [
      await open(url("big.bin", headSha)),
      await open(url("big.bin", headSha)),
    ];
    for (const h of holders) {
      expect(h.res.statusCode).toBe(200);
      // Deliberately never read: `res` is left paused.
      h.res.on("error", () => undefined);
    }
    expect(await waitFor(() => activeRawblobStreams() === 2)).toBe(true);

    // Saturated right now, as designed.
    const shed = await open(url("small.txt", headSha));
    await drain(shed.res);
    expect(shed.res.statusCode).toBe(503);

    // ...and it un-saturates on its own, with the holders still connected.
    expect(await waitFor(() => activeRawblobStreams() === 0, 20_000)).toBe(true);
    expect(await catFileProcesses(bigOid)).toBe(0);

    const served = await open(url("small.txt", headSha));
    const body = await drain(served.res);
    expect(served.res.statusCode).toBe(200);
    expect(body.toString()).toBe("hello\n");

    for (const h of holders) h.abort();
  }, 60_000);

  it("does not interrupt a download that is slow but still moving", async () => {
    // The other side of the reclamation rule, and the one that keeps it from
    // becoming a size ceiling in disguise: the timeout measures *stalling*, not
    // slowness. This client reads a chunk at a time with gaps far shorter than
    // a real link's, but keeps going for several multiples of the stall window,
    // and must never be dropped.
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "600";

    const { res, abort } = await open(url("big.bin", headSha));
    expect(res.statusCode).toBe(200);
    res.pause();

    const started = Date.now();
    let got = 0;
    const outcome = await new Promise<{ error: Error | null; elapsed: number }>((resolve) => {
      res.on("error", (error) => resolve({ error, elapsed: Date.now() - started }));
      res.on("aborted", () => resolve({ error: new Error("aborted"), elapsed: Date.now() - started }));
      const tick = () => {
        const chunk = res.read(64 * 1024);
        if (chunk) got += chunk.length;
        // Four stall windows of trickling, and still alive.
        if (Date.now() - started > 2_400) return resolve({ error: null, elapsed: Date.now() - started });
        setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    });

    expect(outcome.error).toBeNull();
    expect(outcome.elapsed).toBeGreaterThan(600 * 3);
    expect(got).toBeGreaterThan(0);
    abort();
    expect(await waitFor(() => activeRawblobStreams() === 0)).toBe(true);
  }, 60_000);

  it("queues a request past the limit and serves it when a slot frees, rather than shedding at once", async () => {
    // A burst should cost latency, not a failed download: 503 is what happens
    // when the queue *also* fails to clear, not the first response to a full
    // pool.
    process.env["FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS"] = "1";
    process.env["FORGEHUB_RAWBLOB_QUEUE_WAIT_MS"] = "10000";
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "0"; // isolate queueing from reclamation

    const holder = await open(url("big.bin", headSha));
    expect(holder.res.statusCode).toBe(200);
    holder.res.on("error", () => undefined);
    expect(await waitFor(() => activeRawblobStreams() === 1)).toBe(true);

    // This one has nowhere to go yet — it parks instead of failing.
    const queued = open(url("small.txt", headSha));
    expect(await waitFor(() => queuedRawblobStreams() === 1)).toBe(true);

    holder.abort();
    const { res } = await queued;
    const body = await drain(res);
    expect(res.statusCode).toBe(200);
    expect(body.toString()).toBe("hello\n");
    expect(queuedRawblobStreams()).toBe(0);
  }, 60_000);

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
