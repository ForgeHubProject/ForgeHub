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

  it("404s for a file whose extension is not in .forge/formats", async () => {
    const res = await get(`path=readme.md&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
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
});
