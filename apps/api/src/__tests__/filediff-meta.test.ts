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
import { checkoutBranch, createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
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
let addedSha: string;
let featureSha: string;

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
  // A file that exists only from this commit on: its base blob is genuinely
  // absent, which is a zero-byte side, not an unknown one.
  addedSha = await makeCommit(repo.workDir, { "added.gltf": gltf(3) }, "add second scene");
  // A branch, so we can prove the endpoint answers with SHAs and not the ref
  // the caller happened to pass (the PR file view passes the head branch).
  await checkoutBranch(repo.workDir, "feature");
  featureSha = await makeCommit(repo.workDir, { "model.gltf": gltf(11) }, "feature tweak");
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

  // Regression (#66 P4 review): the client pastes headSha into the Tier-L
  // `forge diff --web <base>..<head>` command and abbreviates it, and keys its
  // meta cache on it. Echoing back a branch name corrupted both.
  it("resolves a branch ref to its commit SHA", async () => {
    const res = await get(`path=model.gltf&sha=feature`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headSha).toBe(featureSha);
    expect(body.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.baseSha).toBe(addedSha);
  });

  it("404s for a ref that does not resolve", async () => {
    expect((await get(`path=model.gltf&sha=no-such-branch`)).statusCode).toBe(404);
  });

  // Regression (#66 P4 review): an added file's base blob is absent, so its
  // base size is null while its head size is real — the client must still be
  // able to compute, with the missing side counted as zero bytes.
  it("reports a null size for the side an added file has no blob on", async () => {
    const res = await get(`path=added.gltf&sha=${addedSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseSha).toBe(pinnedSha); // a real parent — the blob just isn't in it
    expect(body.baseSize).toBeNull();
    expect(body.headSize).toBe(Buffer.byteLength(gltf(3)));
  });

  // Regression (#66 P4 review): /filediff 404s when neither blob exists; this
  // endpoint used to answer 200 with both sizes null, which the UI read as a
  // free download of nothing.
  it("404s when the file exists at neither revision (same gate as /filediff)", async () => {
    const res = await get(`path=added.gltf&sha=${baseSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });
});
