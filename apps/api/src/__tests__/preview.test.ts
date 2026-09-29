/**
 * GET /repos/:handle/:name/preview — a handler's preview of one file at a
 * commit (FHR SPEC §7 `preview`). Uses a real bare git repo; prisma is mocked
 * for repo visibility, and the official handlers are stand-ins registered for
 * the manifest's ids, so no wasm release is fetched.
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
import {
  __resetOfficialHandlers,
  __setOfficialHandlerForTests,
  officialWasmDiff,
} from "../fhr/official-handlers.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import type { WasmHandler } from "../fhr/wasm-runtime.js";
import { __clearPreviewCache } from "../routes/preview.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const MANIFEST = `
[formats]
".obj" = { handler = "obj", build = "b0b0b0b" }
".glb" = { handler = "gltf-scene", build = "c1c1c1c" }

[assets.handlers."obj"]
"wasm" = "https://cdn.test/fhr/forge-handler-obj.wasm"

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"
`;

const GLB = "model/gltf-binary";

/** The obj stand-in's preview: its input, tagged, so a test can see which blob it got. */
const previewOf = (blob: Buffer) => Buffer.concat([Buffer.from("glTF:"), blob]);

let objPreviews: string[] = [];
let failNext = false;

function standIns(): void {
  const obj: WasmHandler = {
    diff: async () => ({ version: "1.0", format: "obj", changes: [] }),
    previewType: GLB,
    preview: async (blob) => {
      objPreviews.push(blob.toString());
      if (failNext) throw new Error("parsing OBJ: line 1: invalid number \"x\"");
      return { bytes: previewOf(blob), mediaType: GLB };
    },
  };
  // A handler that draws from the file's own bytes: no preview call at all.
  const gltf: WasmHandler = {
    diff: async () => ({ version: "1.0", format: "gltf-scene", changes: [] }),
  };
  __setOfficialHandlerForTests("obj", obj);
  __setOfficialHandlerForTests("gltf-scene", gltf);
}

let repo: TestRepo;
let app: FastifyInstance;
let sha: string;
let bigSha: string;

const MOCK_REPO = {
  id: "repo-1",
  name: "models",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
};

beforeAll(async () => {
  repo = await createTestRepo("test/preview.git");
  // .obj is deliberately NOT opted in: viewing is not scoped to .forge/formats.
  sha = await makeCommit(
    repo.workDir,
    {
      ".forge/formats": ".glb\n",
      "desk.obj": "o Desk\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
      "model.glb": "glTF-bytes",
      "notes.txt": "hello",
      "dir/inner.obj": "v 0 0 0\n",
    },
    "models",
  );
  // One byte past the 8 MiB a wasm handler call may take.
  bigSha = await makeCommit(repo.workDir, { "big.obj": "#".repeat(8 * 1024 * 1024 + 1) }, "a big model");
  MOCK_REPO.storageKey = repo.storageKey;
  __setManifestForTests(MANIFEST);
  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  __resetManifest();
  __resetOfficialHandlers();
  await repo.cleanup();
  await app.close();
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO } as never);
  __setManifestForTests(MANIFEST);
  __resetOfficialHandlers();
  standIns();
  __clearPreviewCache();
  objPreviews = [];
  failNext = false;
});

const get = (query: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `/repos/alice/models/preview?${query}`, headers });

describe("GET /repos/:handle/:name/preview", () => {
  it("answers the handler's preview with its media type and a content-addressed ETag", async () => {
    const res = await get(`path=desk.obj&sha=${sha}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(GLB);
    expect(res.rawPayload.toString()).toBe("glTF:o Desk\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    // blob oid + handler + build: a handler release is a new ETag.
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{40}\.obj\.b0b0b0b"$/);
    // The build is not in the URL, so revalidate rather than `immutable`.
    expect(res.headers["cache-control"]).toBe("public, no-cache");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("revalidates to 304 without running the handler", async () => {
    const first = await get(`path=desk.obj&sha=${sha}`);
    objPreviews = [];
    const res = await get(`path=desk.obj&sha=${sha}`, { "if-none-match": first.headers["etag"] as string });
    expect(res.statusCode).toBe(304);
    expect(objPreviews).toHaveLength(0);
  });

  it("converts a blob once, however many times it is asked for", async () => {
    await get(`path=desk.obj&sha=${sha}`);
    const again = await get(`path=desk.obj&sha=${sha}`);
    expect(again.statusCode).toBe(200);
    expect(objPreviews).toHaveLength(1);
  });

  it("says a handler with no preview has none, so a client can stop asking", async () => {
    const res = await get(`path=model.glb&sha=${sha}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "no-preview", handlerId: "gltf-scene" });
  });

  it("says the same for a file no official handler covers", async () => {
    const res = await get(`path=notes.txt&sha=${sha}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "no-preview", handlerId: null });
  });

  it("404s a missing file and a directory, and 400s a missing parameter", async () => {
    expect((await get(`path=nope.obj&sha=${sha}`)).statusCode).toBe(404);
    expect((await get(`path=dir&sha=${sha}`)).statusCode).toBe(404);
    expect((await get(`path=desk.obj`)).statusCode).toBe(400);
  });

  it("refuses a blob over the handler limit with the real size, without reading it", async () => {
    const res = await get(`path=big.obj&sha=${bigSha}`);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ size: 8 * 1024 * 1024 + 1, limit: 8 * 1024 * 1024 });
    expect(objPreviews).toHaveLength(0);
  });

  it("reports a file the handler cannot read as 422, not a server fault", async () => {
    failNext = true;
    const res = await get(`path=desk.obj&sha=${sha}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("invalid number");
  });

  it("hides a private repo from strangers and keeps its previews out of shared caches", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    expect((await get(`path=desk.obj&sha=${sha}`)).statusCode).toBe(404);

    const res = await get(`path=desk.obj&sha=${sha}`, { authorization: await authHeader(app, "user-1") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });
});

describe("the diff tells the client a preview exists", () => {
  it("carries the handler's preview media type, and only when it has one", async () => {
    const obj = await officialWasmDiff("desk.obj", new Set([".obj"]), Buffer.alloc(0), Buffer.from("v 0 0 0\n"));
    expect(obj).toMatchObject({ handlerId: "obj", preview: GLB });
    const glb = await officialWasmDiff("model.glb", new Set([".glb"]), Buffer.alloc(0), Buffer.from("x"));
    expect(glb?.handlerId).toBe("gltf-scene");
    expect(glb).not.toHaveProperty("preview");
  });
});
