/**
 * Semantic file-diff endpoint tests. Uses a real bare git repo with committed
 * glTF blobs and a .forge/formats opt-in; prisma is mocked for repo visibility.
 *
 * FHR's manifest is the authority for the semantic gate (stubbed here via the
 * manifest test hook so ".gltf" resolves officially without a network call).
 * The wasm engine itself is mocked (officialWasmDiff) so these endpoint tests
 * assert routing/gating/SHAs deterministically without a real wasm build. The
 * built-in TS fallback has been retired from this path (#74): when the official
 * handler can't run, the endpoint returns 503 — never a substitute engine.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repoCollaborator: { findUnique: vi.fn() },
  },
}));

// Keep the real (manifest-driven) officialHandlerId for the gate; mock only the
// wasm compute so tests don't depend on a real wasm build.
vi.mock("../fhr/official-handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fhr/official-handlers.js")>();
  return { ...actual, officialWasmDiff: vi.fn() };
});

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { officialWasmDiff } from "../fhr/official-handlers.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

// ".gltf" → gltf-scene, official per the (stubbed) manifest.
const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }
".glb"  = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

// A deterministic StructuredDiff the mocked wasm engine returns.
const DETERMINISTIC_DIFF = {
  diff: {
    version: "1.0" as const,
    format: "gltf-scene",
    changes: [{ path: "nodes/0", kind: "modified" as const, label: "Cube" }],
  },
  handlerId: "gltf-scene",
};

const gltf = (x: number) =>
  JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Cube", translation: [x, 0, 0] }],
  });

let repo: TestRepo;
let app: FastifyInstance;
let baseSha: string;
let headSha: string;
let communitySha: string;
let notEnabledSha: string;
let oversizeSha: string;
let fileSha: string;
let dirSha: string;
let restoredSha: string;

// One byte past the 10 MiB the API is willing to hold in memory (#157). The
// content is irrelevant — nothing ever parses it, because both routes refuse it
// on the pre-flight size alone.
const OVERSIZE_BYTES = 10 * 1024 * 1024 + 1;

const MOCK_REPO = {
  id: "repo-1",
  name: "scene",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
} as const;

beforeAll(async () => {
  repo = await createTestRepo("test/filediff.git");
  baseSha = await makeCommit(
    repo.workDir,
    { ".forge/formats": ".gltf\n", "model.gltf": gltf(0) },
    "init scene",
  );
  headSha = await makeCommit(repo.workDir, { "model.gltf": gltf(5) }, "move cube");
  // A repo can opt a format into .forge/formats that no *official* FHR handler
  // covers (e.g. a community handler). The server must still refuse to diff it.
  communitySha = await makeCommit(
    repo.workDir,
    { ".forge/formats": ".gltf\n.widget\n", "part.widget": "v=1" },
    "opt in a community format",
  );
  // ".glb" is official per the (stubbed) manifest but never appears in this
  // repo's .forge/formats — the enabled-elsewhere case #73 turns into a CTA.
  notEnabledSha = await makeCommit(
    repo.workDir,
    { "models/Untitled.glb": "glb-bytes" },
    "add a glb without opting the format in",
  );
  // A .gltf (opted in, official) that is larger than the in-memory limit.
  oversizeSha = await makeCommit(
    repo.workDir,
    { "huge.gltf": "x".repeat(OVERSIZE_BYTES) },
    "add an oversized model",
  );
  // A path that is a FILE at one commit and a DIRECTORY at the next, then a
  // file again — git permits the transition, and it is the only way to get a
  // `not-blob` head with a perfectly readable base.
  fileSha = await makeCommit(repo.workDir, { "swap.gltf": gltf(1) }, "swap.gltf as a file");
  await rm(join(repo.workDir, "swap.gltf"));
  dirSha = await makeCommit(repo.workDir, { "swap.gltf/inner.gltf": gltf(2) }, "swap.gltf becomes a dir");
  await rm(join(repo.workDir, "swap.gltf"), { recursive: true });
  restoredSha = await makeCommit(repo.workDir, { "swap.gltf": gltf(3) }, "swap.gltf is a file again");
  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
  __setManifestForTests(MANIFEST);
  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  __resetManifest();
  await repo.cleanup();
  await app.close();
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  __setManifestForTests(MANIFEST);
  vi.mocked(officialWasmDiff).mockResolvedValue(DETERMINISTIC_DIFF);
});

function get(query: string) {
  return app.inject({ method: "GET", url: `/repos/alice/scene/filediff?${query}` });
}

describe("GET /repos/:handle/:name/filediff", () => {
  it("returns the official wasm StructuredDiff for a changed glTF file", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("gltf-scene");
    expect(body.handlerId).toBe("gltf-scene");
    expect(body.engine).toBe("wasm");
    expect(Array.isArray(body.changes)).toBe(true);
    expect(JSON.stringify(body.changes)).toContain("Cube");
  });

  it("uses an explicit base when provided", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}&base=${baseSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe("gltf-scene");
  });

  it("returns the base/head commit SHAs so a client renderer can fetch raw blobs", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}`);
    const body = res.json();
    expect(body.headSha).toBe(headSha);
    expect(body.baseSha).toBe(baseSha);
  });

  it("503s when the official wasm handler is unavailable — no built-in fallback (#74)", async () => {
    vi.mocked(officialWasmDiff).mockResolvedValueOnce(null);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(503);
    // The response must not carry a substitute engine's answer.
    expect(res.json().engine).toBeUndefined();
  });

  it("400s without required params", async () => {
    expect((await get(`sha=${headSha}`)).statusCode).toBe(400);
    expect((await get(`path=model.gltf`)).statusCode).toBe(400);
  });

  it("404s for a file whose extension has no official handler at all", async () => {
    // ".md" maps to nothing in the manifest — genuinely unsupported, so the
    // honest 404 stands (no call-to-action payload, #73 case 2).
    const res = await get(`path=readme.md&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "No semantic handler for this file" });
  });

  it("returns a format-not-enabled CTA for an official ext the repo hasn't opted in (#73 case 1)", async () => {
    // ".glb" is official per the manifest but absent from .forge/formats at
    // this commit — a fixable state, answered 200 with the hint commands.
    vi.mocked(officialWasmDiff).mockClear();
    const res = await get(`path=models/Untitled.glb&sha=${notEnabledSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "format-not-enabled",
      path: "models/Untitled.glb",
      ext: ".glb",
      message: "Format .glb is not added to this repo's .forge/formats.",
      hint: ["forge formats add .glb", "forge formats ignore .glb"],
    });
    // No handler ever runs for a not-enabled file — messaging only.
    expect(vi.mocked(officialWasmDiff)).not.toHaveBeenCalled();
  });

  it("404s for an opted-in but non-official extension (the manifest is the authority, not opt-in alone)", async () => {
    // .widget is in .forge/formats at communitySha but the manifest maps no
    // official handler to it, so the server refuses — a community handler would
    // run in the consented client sandbox (#70), never here.
    const res = await get(`path=part.widget&sha=${communitySha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("413s — not 404s — for a file too large to hold in memory, and names the real size (#157)", async () => {
    // The wasm engine takes whole buffers, so this route is genuinely capped.
    // The file is present and browsable; calling it "not found" was the lie.
    vi.mocked(officialWasmDiff).mockClear();
    const res = await get(`path=huge.gltf&sha=${oversizeSha}`);
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.size).toBe(OVERSIZE_BYTES);
    expect(body.limit).toBe(10 * 1024 * 1024);
    expect(body.path).toBe("huge.gltf");
    expect(body.error).toMatch(/too large/i);
    // Nothing was ever handed to the engine.
    expect(vi.mocked(officialWasmDiff)).not.toHaveBeenCalled();
  });

  it("400s — not 413s — for a malformed request whose other side is over the cap", async () => {
    // Ordering. `base` carries a NUL, so the base read is `invalid`; the head
    // is the oversized file, so it is `too-large`. Checking too-large first
    // answered 413 "File too large to diff" — reporting a size limit as the
    // reason a malformed request failed, and naming a limit the caller never
    // came close to violating on the side they got wrong.
    vi.mocked(officialWasmDiff).mockClear();
    const res = await get(
      `path=huge.gltf&sha=${oversizeSha}&base=${encodeURIComponent(`${baseSha}\0x`)}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid/i);
    expect(vi.mocked(officialWasmDiff)).not.toHaveBeenCalled();
  });

  it("404s for a head path that is a DIRECTORY instead of calling the file deleted (#157)", async () => {
    // /rawblob answers a directory with an honest 404. This route had exactly
    // the same `not-blob` pre-flight answer in hand and dropped it on the
    // floor: the head became an empty buffer, the readable base diffed against
    // it, and the response said the file had been DELETED. It was not deleted;
    // the path is not a file.
    vi.mocked(officialWasmDiff).mockClear();
    const res = await get(`path=swap.gltf&sha=${dirSha}&base=${fileSha}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Path is not a file at this commit", path: "swap.gltf" });
    // And the engine was never handed a fabricated empty head.
    expect(vi.mocked(officialWasmDiff)).not.toHaveBeenCalled();
  });

  it("still diffs a file whose BASE path was a directory, as an addition", async () => {
    // The deliberate asymmetry, pinned so the refusal above does not quietly
    // widen: a tree at the *base* path is not a lie about the head. The file
    // genuinely did not exist at that path before, so an empty base — the same
    // treatment a missing base gets — is the honest reading.
    const res = await get(`path=swap.gltf&sha=${restoredSha}&base=${dirSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().engine).toBe("wasm");
    const [, , baseBlob] = vi.mocked(officialWasmDiff).mock.calls.at(-1)!;
    expect(baseBlob.length).toBe(0);
  });

  it("404s — never 500s — for a path git's revision parser refuses (#157)", async () => {
    // Same regression as on /rawblob: a `../`-prefixed path exits git 128, and
    // reporting a client-supplied path as a server failure is both a lie and an
    // unbounded 5xx source. (".gltf" keeps it past the format gate.)
    const res = await get(`path=${encodeURIComponent("../../x.gltf")}&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("never reaches the blob read for a NUL-bearing path (#157)", async () => {
    // A NUL makes the extension unrecognisable, so this route's format gate
    // refuses first with its own honest 404 ("no semantic handler"). The
    // `invalid` → 400 branch below it is defence in depth, not the live answer
    // here; /rawblob, which has no format gate, is where it is observable.
    const res = await get(`path=${encodeURIComponent(`model.gltf\0${headSha}:nope`)}&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/semantic handler/i);
  });
});

function rawblob(query: string) {
  return app.inject({ method: "GET", url: `/repos/alice/scene/rawblob?${query}` });
}

describe("GET /repos/:handle/:name/rawblob", () => {
  it("returns the raw file bytes as application/octet-stream", async () => {
    const res = await rawblob(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    // The bytes are the committed blob verbatim — a client renderer parses them.
    expect(res.body).toBe(gltf(5));
  });

  it("400s without required params", async () => {
    expect((await rawblob(`sha=${headSha}`)).statusCode).toBe(400);
    expect((await rawblob(`path=model.gltf`)).statusCode).toBe(400);
  });

  it("404s for a path absent at that commit", async () => {
    const res = await rawblob(`path=does-not-exist.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await rawblob(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a DIRECTORY instead of serving a tree listing as file bytes (#157)", async () => {
    // `git show <sha>:<dir>` exits 0 and pretty-prints the tree, which this
    // route used to hand back with a 200 and an octet-stream content type.
    const res = await rawblob(`path=.forge&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("formats");
  });

  it("serves a file larger than the diff buffer IN FULL — this route has no size ceiling (#157)", async () => {
    // The product requirement: a contributor who can push an arbitrarily large
    // file can fetch it back. This route streams, so there is no resource a
    // ceiling would protect — refusing here (413, or the old fake 404) makes a
    // pushed file unfetchable. `huge.gltf` is past the buffer limit that
    // /filediff is genuinely bound by; this route must not inherit it.
    const res = await rawblob(`path=huge.gltf&sha=${oversizeSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    // Every byte, and a Content-Length that lets a client detect truncation.
    expect(res.rawPayload.length).toBe(OVERSIZE_BYTES);
    expect(res.headers["content-length"]).toBe(String(OVERSIZE_BYTES));
    expect(res.rawPayload.equals(Buffer.from("x".repeat(OVERSIZE_BYTES)))).toBe(true);
  }, 30_000);

  it("404s — never 500s — for a path git's revision parser refuses (#157)", async () => {
    // `git cat-file --batch-check` reports most negatives in-band and exits 0,
    // but a `./`- or `../`-prefixed path aborts it with exit 128 before any
    // request is read. Treating that as a git failure would let any reader of a
    // public repo mint unbounded 5xx by varying one query param — and it is a
    // path that names nothing, which is a 404 like any other absent path.
    for (const p of ["../../../etc/passwd", "../../x.gltf", "./model.gltf"]) {
      const res = await rawblob(`path=${encodeURIComponent(p)}&sha=${headSha}`);
      expect([res.statusCode, p]).toEqual([404, p]);
    }
  });

  it("400s for a NUL in the path instead of misparsing it into 'not found' (#157)", async () => {
    // NUL is the framing character statBlob writes to `cat-file --batch-check
    // -z`. One inside the path makes git read two requests and emit two lines,
    // which the anchored blob pattern then rejects — answering "not found"
    // about a file that is right there. The request is malformed; say so.
    const res = await rawblob(`path=${encodeURIComponent(`model.gltf\0${headSha}:nope`)}&sha=${headSha}`);
    expect(res.statusCode).toBe(400);
  });

  it("still serves a small file byte-for-byte after the size pre-flight", async () => {
    // The pre-flight must not change the happy path: same bytes, same headers.
    const res = await rawblob(`path=model.gltf&sha=${oversizeSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(res.body).toBe(gltf(5));
  });
});
