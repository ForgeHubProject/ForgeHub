/**
 * Compute-tier metadata endpoint tests (issue #66 P4). Uses a real bare git
 * repo with committed glTF blobs, a .forge/formats opt-in and a .forge/handlers
 * lockfile; prisma is mocked for repo visibility and the manifest is stubbed
 * via the test hook.
 *
 * The endpoint answers WITHOUT computing a diff: blob SHAs + sizes (honest
 * Tier-B download costs, the Tier-L forge command), wasm availability (Tier-B
 * capability detection), and the manifest build vs. the repo's pin (surfacing
 * build skew). Gating must mirror /filediff exactly.
 */
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
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

// The manifest's current build for gltf-scene is e520cc6; the test repo's
// lockfile deliberately pins an OLDER build so the mismatch surfaces.
const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

// Same shape, but no wasm asset — Tier B must be reported unavailable.
const MANIFEST_NO_WASM = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

const gltf = (x: number) =>
  JSON.stringify({ asset: { version: "2.0" }, nodes: [{ name: "Cube", translation: [x, 0, 0] }] });

let repo: TestRepo;
let app: FastifyInstance;
let baseSha: string;
let headSha: string;
let pinnedSha: string;

const MOCK_REPO = {
  id: "repo-1",
  name: "scene",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
} as const;

beforeAll(async () => {
  repo = await createTestRepo("test/filediff-meta.git");
  baseSha = await makeCommit(
    repo.workDir,
    { ".forge/formats": ".gltf\n", "model.gltf": gltf(0) },
    "init scene",
  );
  headSha = await makeCommit(repo.workDir, { "model.gltf": gltf(5) }, "move cube");
  // Commit a lockfile pinning a build that differs from the manifest's current
  // one — the endpoint must report both sides so the UI can shout about it.
  pinnedSha = await makeCommit(
    repo.workDir,
    { ".forge/handlers": '{\n  "gltf-scene": "0ldbld1"\n}\n', "model.gltf": gltf(9) },
    "pin handler build",
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
});

function get(query: string) {
  return app.inject({ method: "GET", url: `/repos/alice/scene/filediff-meta?${query}` });
}

describe("GET /repos/:handle/:name/filediff-meta", () => {
  it("returns SHAs, honest blob sizes, wasm availability and the manifest build", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.handlerId).toBe("gltf-scene");
    expect(body.path).toBe("model.gltf");
    expect(body.headSha).toBe(headSha);
    expect(body.baseSha).toBe(baseSha);
    // Sizes are the exact committed blob byte counts — what Tier B downloads.
    expect(body.baseSize).toBe(Buffer.byteLength(gltf(0)));
    expect(body.headSize).toBe(Buffer.byteLength(gltf(5)));
    expect(body.wasmAvailable).toBe(true);
    expect(body.officialBuild).toBe("e520cc6");
    // No lockfile at this commit → nothing pinned.
    expect(body.pinnedBuild).toBeNull();
  });

  it("returns the repo's .forge/handlers pin alongside the manifest build", async () => {
    const res = await get(`path=model.gltf&sha=${pinnedSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pinnedBuild).toBe("0ldbld1");
    expect(body.officialBuild).toBe("e520cc6"); // differs → the UI must say so
  });

  it("reports wasmAvailable=false when the manifest has no wasm asset", async () => {
    __setManifestForTests(MANIFEST_NO_WASM);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().wasmAvailable).toBe(false);
  });

  it("uses an explicit base when provided", async () => {
    const res = await get(`path=model.gltf&sha=${pinnedSha}&base=${baseSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseSha).toBe(baseSha);
    expect(body.baseSize).toBe(Buffer.byteLength(gltf(0)));
    expect(body.headSize).toBe(Buffer.byteLength(gltf(9)));
  });

  it("400s without required params", async () => {
    expect((await get(`sha=${headSha}`)).statusCode).toBe(400);
    expect((await get(`path=model.gltf`)).statusCode).toBe(400);
  });

  it("404s for a file with no semantic support (same gate as /filediff)", async () => {
    const res = await get(`path=readme.md&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });
});
