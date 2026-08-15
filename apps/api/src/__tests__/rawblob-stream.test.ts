/**
 * /rawblob streaming behaviour, over a REAL socket.
 *
 * These tests exist because `app.inject()` cannot see the thing that matters
 * here. Inject buffers the whole response through a fake socket and hands back
 * the bytes, so a body that ends short of its `Content-Length` and a body that
 * never ends at all are indistinguishable — and the mid-stream failure guard
 * lives exactly in that gap. Everything below therefore listens on a real port
 * and drives it with a real `http` client.
 *
 * Two behaviours are pinned, and they pull in opposite directions:
 *
 * 1. When git dies mid-stream, the response must abort *immediately*, not end
 *    quietly short of Content-Length and leave the socket parked until an
 *    unrelated keep-alive timeout reaps it 72 seconds later.
 * 2. Nothing may abort a transfer that is merely slow. `/rawblob` has no size
 *    ceiling by product requirement, and a timeout on a still-progressing
 *    download *is* a size ceiling for slow links — below some byte rate a large
 *    file would never be fetchable. The slow-consumer test is the guard on the
 *    guard.
 *
 * The consumer in (1) is deliberately FAST. That is the path the older tests
 * missed: whether git's stdout has already EOF'd when the child's exit is
 * noticed is decided by the consumer's speed, and a consumer that keeps up
 * reaches EOF first. A fix that signals through stdout passes with a paused
 * consumer and does nothing at all here.
 *
 * git failure is injected with a PATH shim rather than a mock, so the real
 * route, the real `openBlobStream`, and the real Fastify stream plumbing are all
 * on the wire. The shim delegates every other git invocation (notably the
 * `cat-file --batch-check` pre-flight, which must still report the true size) to
 * the real binary.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repoCollaborator: { findUnique: vi.fn() },
  },
}));

import http from "node:http";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";
import {
  MAX_CONCURRENT_RAWBLOB_STREAMS,
  tryAcquireRawblobStream,
  releaseRawblobStream,
  activeRawblobStreams,
} from "../rawblob-http.js";

const execFile = promisify(execFileCb);

/**
 * 8 MiB — comfortably past the 10 MiB the *diff* path buffers is not the point
 * here; what matters is that it is far more than any single chunk, so a stream
 * cut short is unambiguous and a slow consumer has hundreds of chunks to crawl
 * through.
 */
const BIG_BYTES = 8 * 1024 * 1024;
const BIG_CONTENT = "x".repeat(BIG_BYTES);

let repo: TestRepo;
let app: FastifyInstance;
let sha: string;
let baseUrl: string;
let shimDir: string;
let realPath: string;

const MOCK_REPO = {
  id: "repo-1",
  name: "scene",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
} as const;

beforeAll(async () => {
  realPath = process.env["PATH"] ?? "";
  const { stdout: gitBin } = await execFile("sh", ["-c", "command -v git"]);

  // A `git` that fails only for `cat-file blob`, and only when asked to. Every
  // other invocation — including the size pre-flight this route depends on —
  // is the real binary, so Content-Length still reports the true blob size and
  // the failure is genuinely mid-*stream*.
  //
  // FH_TEST_BLOB_FAIL_KIB: KiB of body to emit before dying. "" disables the
  // shim entirely; "0" dies before a single byte (a bad-oid style exit).
  shimDir = await mkdtemp(join(tmpdir(), "fh-gitshim-"));
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
if [ "$1" = "cat-file" ] && [ "$2" = "blob" ] && [ -n "\${FH_TEST_BLOB_FAIL_KIB}" ]; then
  if [ "\${FH_TEST_BLOB_FAIL_KIB}" != "0" ]; then
    dd if=/dev/zero bs=1024 count="\${FH_TEST_BLOB_FAIL_KIB}" 2>/dev/null
  fi
  exit 128
fi
exec ${gitBin.trim()} "$@"
`,
    "utf8",
  );
  await chmod(join(shimDir, "git"), 0o755);

  repo = await createTestRepo("test/rawblob-stream.git");
  sha = await makeCommit(repo.workDir, { "huge.bin": BIG_CONTENT }, "add a big asset");
  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;

  app = await createTestServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await app.close();
  await repo.cleanup();
  await rm(shimDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
});

afterEach(() => {
  process.env["PATH"] = realPath;
  delete process.env["FH_TEST_BLOB_FAIL_KIB"];
});

/** Make the next `cat-file blob` emit `kib` KiB and then exit 128. */
function breakBlobStreamAfter(kib: number) {
  process.env["PATH"] = `${shimDir}:${realPath}`;
  process.env["FH_TEST_BLOB_FAIL_KIB"] = String(kib);
}

type Outcome = {
  /** "complete" = every advertised byte arrived; "aborted" = the connection was
   *  cut; "stalled" = neither, within the deadline (the pre-fix behaviour). */
  kind: "complete" | "aborted" | "stalled";
  status: number;
  contentLength: string;
  bytes: number;
  ms: number;
};

/**
 * Drive one /rawblob request over the real socket.
 *
 * `slowFor` throttles the consumer: while elapsed time is under it, the body is
 * paused for `slowPause` after every chunk. Default (0) is a FAST consumer, one
 * that keeps up with git — the case a stdout-based guard silently misses.
 */
function consume(
  path: string,
  opts: { deadline: number; slowFor?: number; slowPause?: number } = { deadline: 5_000 },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let bytes = 0;
    let status = 0;
    let contentLength = "";
    let settled = false;

    const finish = (kind: Outcome["kind"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ kind, status, contentLength, bytes, ms: Date.now() - t0 });
    };

    const timer = setTimeout(() => finish("stalled"), opts.deadline);
    const req = http.get(`${baseUrl}${path}`, (res) => {
      status = res.statusCode ?? 0;
      contentLength = String(res.headers["content-length"] ?? "");
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (opts.slowFor && Date.now() - t0 < opts.slowFor) {
          res.pause();
          setTimeout(() => res.resume(), opts.slowPause ?? 100);
        }
      });
      // A destroyed socket surfaces as "aborted"/ECONNRESET, or as an "end"
      // whose `complete` is false — all three mean the same thing to a caller.
      res.on("aborted", () => finish("aborted"));
      res.on("error", () => finish("aborted"));
      res.on("end", () => finish(res.complete ? "complete" : "aborted"));
    });
    req.on("error", () => finish("aborted"));
  });
}

const RAWBLOB = () => `/repos/alice/scene/rawblob?path=huge.bin&sha=${sha}`;

describe("GET /rawblob — mid-stream git failure (real socket)", () => {
  it("aborts the response AT ONCE when git dies mid-stream, with a consumer that is keeping up", async () => {
    // The regression this pins: git's stdout EOFs on death rather than
    // erroring, so the response used to *end* — short of Content-Length, with
    // no error anywhere — and the socket then idled until Fastify's 72s
    // keep-alive timeout. To a client that is nothing but a very long pause.
    //
    // The consumer here is deliberately fast: it is the case where stdout has
    // already EOF'd by the time the child's exit is seen, so `stdout.destroy()`
    // is a silent no-op and only destroying the response itself does anything.
    breakBlobStreamAfter(256);
    const out = await consume(RAWBLOB(), { deadline: 5_000 });

    expect(out.status).toBe(200);
    // The pre-flight still ran against the real git, so the advertised length is
    // the true size — which is what makes the short body detectable at all.
    expect(out.contentLength).toBe(String(BIG_BYTES));
    expect(out.bytes).toBeLessThan(BIG_BYTES);
    expect(out.kind).toBe("aborted");
    // Immediately: the whole point is not "eventually observable" (Content-Length
    // already gave that) but "observable now". Anything near 72s means the
    // response was left to rot on the keep-alive timeout.
    expect(out.ms).toBeLessThan(2_000);
  }, 20_000);

  it("aborts at once when git dies before writing a single byte (bad-oid shape)", async () => {
    // git exiting 128 immediately is the other half of the same bug: zero bytes
    // written, stdout EOFs, the response ends with a 200 and an empty body that
    // claims 8 MiB of Content-Length. Same treatment.
    breakBlobStreamAfter(0);
    const out = await consume(RAWBLOB(), { deadline: 5_000 });

    expect(out.status).toBe(200);
    expect(out.contentLength).toBe(String(BIG_BYTES));
    expect(out.bytes).toBe(0);
    expect(out.kind).toBe("aborted");
    expect(out.ms).toBeLessThan(2_000);
  }, 20_000);
});

describe("GET /rawblob — no size ceiling, by any mechanism", () => {
  it("delivers every byte to a fast consumer", async () => {
    // Negative control for the guard above: a healthy stream must not be
    // aborted by it. git exits 0, so onFailure never fires.
    const out = await consume(RAWBLOB(), { deadline: 30_000 });

    expect(out.status).toBe(200);
    expect(out.kind).toBe("complete");
    expect(out.bytes).toBe(BIG_BYTES);
    expect(out.contentLength).toBe(String(BIG_BYTES));
  }, 60_000);

  it("delivers every byte to a SLOW consumer — a stalling client is never cut off", async () => {
    // The maintainer's requirement, pinned: raw blobs stream with no size
    // ceiling and no mechanism may act as one. A timeout that killed a
    // slow-but-progressing download would be a size ceiling for slow links —
    // below some byte rate a large file could never be fetched at all, and with
    // no Range support it could not be resumed either.
    //
    // This consumer crawls for several seconds — long enough that any idle or
    // whole-request deadline anyone is tempted to add would fire — and must
    // still receive all 8 MiB.
    const out = await consume(RAWBLOB(), { deadline: 60_000, slowFor: 4_000, slowPause: 120 });

    expect(out.status).toBe(200);
    expect(out.kind).toBe("complete");
    expect(out.bytes).toBe(BIG_BYTES);
    // The crawl really did take a while — otherwise this proves nothing.
    expect(out.ms).toBeGreaterThan(3_000);
  }, 90_000);

  it("leaves no git child behind when a client disconnects mid-download", async () => {
    // Each in-flight /rawblob holds a live git child for the connection's
    // lifetime, where the buffered implementation released it as soon as it had
    // the bytes. That is intended — you cannot stream without a producer — but
    // it must not accumulate: the child has to die with the connection.
    const before = await countCatFileChildren();
    // Throttled hard so every one of these is still mid-download when its
    // deadline cuts the connection — a completed request proves nothing here.
    const aborted = await Promise.all(
      Array.from({ length: 5 }, () =>
        consume(RAWBLOB(), { deadline: 400, slowFor: 30_000, slowPause: 200 }),
      ),
    );
    expect(aborted.every((o) => o.kind !== "complete")).toBe(true);

    // Give the kill-on-close handler a moment to reap.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await countCatFileChildren()).toBeLessThanOrEqual(before);
  }, 30_000);
});

describe("GET/HEAD /rawblob — the abort never fires on a healthy response", () => {
  it("keeps one keep-alive connection alive across repeated GETs and HEADs", async () => {
    // The guard cuts the connection when git fails, so the cost of getting it
    // wrong is paid by every *successful* request on a reused socket. HEAD is
    // where that bites: the response is complete the moment the headers are
    // out (its answer comes from the pre-flight, and Node discards the body),
    // but the git child is still busy pushing megabytes into the void, so the
    // kill-on-close hits a live process and reports a "failure" for a response
    // that was never short a byte. Before the HEAD guard existed, every second
    // HEAD on this agent came back ECONNRESET — the client picking up a socket
    // the server had just destroyed.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const ports = new Set<number>();
      for (let i = 0; i < 4; i++) {
        const g = await request("GET", agent);
        expect([g.kind, g.bytes]).toEqual(["complete", BIG_BYTES]);
        ports.add(g.port);
        const h = await request("HEAD", agent);
        expect(h.kind).toBe("complete");
        expect(h.contentLength).toBe(String(BIG_BYTES));
        ports.add(h.port);
      }
      // One socket for all eight requests: nothing tore the connection down.
      expect(ports.size).toBe(1);
    } finally {
      agent.destroy();
    }
  }, 60_000);
});

describe("GET /rawblob — validators, caching, and the stream cap (#157 hardening)", () => {
  // The pure decision logic (visibility split, weak comparison, cap floor) is
  // unit-tested cross-platform in rawblob-http.test.ts; what belongs HERE is
  // only what needs the real route on a real socket: that the headers actually
  // reach the wire, that a 304 short-circuits before any git child is spawned,
  // and that the route releases its slot when the response closes.

  async function blobOid(): Promise<string> {
    const { stdout } = await execFile("git", ["rev-parse", `${sha}:huge.bin`], {
      cwd: repo.workDir,
    });
    return stdout.trim();
  }

  function headOnly(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    bytes: number;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}${path}`, { headers }, (res) => {
        let bytes = 0;
        res.on("data", (c: Buffer) => { bytes += c.length; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes }));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
  }

  it("emits the oid ETag, the public cache policy, nosniff, and Accept-Ranges: none", async () => {
    const oid = await blobOid();
    const res = await headOnly(RAWBLOB());
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe(`"${oid}"`);
    // MOCK_REPO is PUBLIC; the private branch of the split is unit-tested.
    expect(res.headers["cache-control"]).toBe("public, max-age=3600, immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["accept-ranges"]).toBe("none");
  });

  it("answers If-None-Match with a bodiless 304 that repeats the validators", async () => {
    const oid = await blobOid();
    const res = await headOnly(RAWBLOB(), { "if-none-match": `"${oid}"` });
    expect(res.status).toBe(304);
    expect(res.bytes).toBe(0);
    expect(res.headers["etag"]).toBe(`"${oid}"`);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600, immutable");
  });

  it("refuses the request past the cap with 503 + Retry-After, and recovers on release", async () => {
    // Saturate the shared counter directly — the route and this test import the
    // same module — so the refusal is deterministic rather than racing five
    // slow downloads against each other.
    const claimed: number[] = [];
    while (tryAcquireRawblobStream()) claimed.push(1);
    try {
      const refused = await headOnly(RAWBLOB());
      expect(refused.status).toBe(503);
      expect(refused.headers["retry-after"]).toBe("5");
      expect(refused.headers["cache-control"]).toBe("no-store");
    } finally {
      for (const _ of claimed) releaseRawblobStream();
    }
    const ok = await headOnly(RAWBLOB());
    expect(ok.status).toBe(200);
  });

  it("still serves 304s while saturated — the conditional path spawns nothing", async () => {
    const oid = await blobOid();
    const claimed: number[] = [];
    while (tryAcquireRawblobStream()) claimed.push(1);
    try {
      const res = await headOnly(RAWBLOB(), { "if-none-match": `"${oid}"` });
      expect(res.status).toBe(304);
    } finally {
      for (const _ of claimed) releaseRawblobStream();
    }
  });

  it("releases its slot when the response closes, including on client disconnect", async () => {
    expect(activeRawblobStreams()).toBe(0);
    // A completed fast download and an aborted slow one must both return to 0.
    const done = await consume(RAWBLOB(), { deadline: 30_000 });
    expect(done.kind).toBe("complete");
    const cut = await consume(RAWBLOB(), { deadline: 400, slowFor: 30_000, slowPause: 200 });
    expect(cut.kind).not.toBe("complete");
    // Give the close handlers the same beat the child-reaper test allows.
    await new Promise((r) => setTimeout(r, 500));
    expect(activeRawblobStreams()).toBe(0);
    expect(MAX_CONCURRENT_RAWBLOB_STREAMS).toBeGreaterThan(0);
  }, 60_000);
});

/** One request over a shared agent, reporting which socket carried it. */
function request(
  method: "GET" | "HEAD",
  agent: http.Agent,
): Promise<{ kind: "complete" | "aborted"; bytes: number; port: number; contentLength: string }> {
  return new Promise((resolve) => {
    let bytes = 0;
    let port = -1;
    let contentLength = "";
    let settled = false;
    const finish = (kind: "complete" | "aborted") => {
      if (settled) return;
      settled = true;
      resolve({ kind, bytes, port, contentLength });
    };
    const req = http.request(`${baseUrl}${RAWBLOB()}`, { agent, method }, (res) => {
      port = res.socket.localPort ?? -1;
      contentLength = String(res.headers["content-length"] ?? "");
      res.on("data", (c: Buffer) => { bytes += c.length; });
      res.on("aborted", () => finish("aborted"));
      res.on("error", () => finish("aborted"));
      res.on("end", () => finish(res.complete ? "complete" : "aborted"));
    });
    req.on("error", () => finish("aborted"));
    req.end();
  });
}

/**
 * Count live `git cat-file blob` children of this process.
 *
 * The match is anchored to ps's PID columns rather than run over the whole
 * line, and the helper's own shell is excluded by pid. A plain
 * `grep "cat-file blob"` over ps output also matches this very `sh -c`, whose
 * arguments contain that literal, so it reported 1 with no git child alive at
 * all. That constant offset cancelled out of the before/after comparison
 * below, but it would quietly absorb a one-child leak the moment the baseline
 * was sampled anywhere else. `ps` and `awk` are children of the helper shell,
 * not of this process, so the ppid filter already drops them.
 */
async function countCatFileChildren(): Promise<number> {
  const { stdout } = await execFile("sh", [
    "-c",
    `ps -o pid=,ppid=,args= -e | awk -v me=$$ -v parent=${process.pid} ` +
      `'$2 == parent && $1 != me && index($0, "cat-file blob") { n++ } END { print n + 0 }'`,
  ]);
  return Number(stdout.trim()) || 0;
}
