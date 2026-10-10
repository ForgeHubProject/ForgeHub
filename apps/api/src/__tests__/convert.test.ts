/**
 * GET /repos/:handle/:name/convert and GET /convert/formats — transcoding a 3D
 * file through glTF (FHR SPEC §7 `import` / `export`). Uses a real bare git repo;
 * prisma is mocked for repo visibility, and the official handlers are stand-ins
 * registered for the manifest's ids, so no wasm release is fetched.
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
  officialWasmConvert,
} from "../fhr/official-handlers.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import type { WasmHandler } from "../fhr/wasm-runtime.js";
import { __clearConversionCache } from "../routes/convert.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const MANIFEST = `
[formats]
".obj" = { handler = "obj", build = "b0b0b0b" }
".stl" = { handler = "stl", build = "5151515" }
".glb" = { handler = "gltf-scene", build = "c1c1c1c" }
".csv" = { handler = "csv", build = "d2d2d2d" }

[assets.handlers."obj"]
"wasm" = "https://cdn.test/fhr/forge-handler-obj.wasm"
[assets.handlers."stl"]
"wasm" = "https://cdn.test/fhr/forge-handler-stl.wasm"
[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"
[assets.handlers."csv"]
"wasm" = "https://cdn.test/fhr/forge-handler-csv.wasm"
`;

let imports: string[] = [];
let exports: Array<{ glb: string; format: string }> = [];
let failImport = false;
let failExport = false;

const enc = (s: string) => new TextEncoder().encode(s);

/** A handler that can both read and write its format, tagging what it was given. */
function transcoder(id: string, formats: string[]): WasmHandler {
  return {
    diff: async () => ({ version: "1.0", format: id, changes: [] }),
    canImport: true,
    canExport: true,
    formats,
    import: async (blob) => {
      imports.push(blob.toString());
      if (failImport) throw new Error("parsing OBJ: line 1: invalid number \"x\"");
      return { bytes: enc(`GLB[${blob.toString()}]`) };
    },
    export: async (glb, format) => {
      exports.push({ glb: glb.toString(), format });
      if (failExport) throw new Error("the scene has no triangles to write");
      return enc(`${id}:${format}:${glb.toString()}`);
    },
  };
}

function standIns(): void {
  __setOfficialHandlerForTests("obj", transcoder("obj", [".obj"]));
  __setOfficialHandlerForTests("stl", transcoder("stl", [".stl"]));
  // Exports only: a format ForgeHub can write but not read.
  __setOfficialHandlerForTests("gltf-scene", { ...transcoder("gltf-scene", [".gltf", ".glb"]), canImport: false });
  // A handler that does neither (a diff-only format).
  __setOfficialHandlerForTests("csv", { diff: async () => ({ version: "1.0", format: "csv", changes: [] }) });
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
  repo = await createTestRepo("test/convert.git");
  sha = await makeCommit(
    repo.workDir,
    {
      "desk.obj": "o Desk\nv 0 0 0\n",
      "parts/Bracket Plate.obj": "o Plate\n",
      "model.glb": "glTF-bytes",
      "data.csv": "a,b\n1,2\n",
      "notes.txt": "hello",
    },
    "models",
  );
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
  __clearConversionCache();
  imports = [];
  exports = [];
  failImport = false;
  failExport = false;
});

const get = (query: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `/repos/alice/models/convert?${query}`, headers });

describe("GET /repos/:handle/:name/convert", () => {
  it("pivots through glTF: the source imports, the target exports", async () => {
    const res = await get(`path=desk.obj&sha=${sha}&to=stl`);
    expect(res.statusCode).toBe(200);
    expect(imports).toEqual(["o Desk\nv 0 0 0\n"]);
    // The exporter is handed the GLB the importer made, and the normalised target.
    expect(exports).toEqual([{ glb: "GLB[o Desk\nv 0 0 0\n]", format: ".stl" }]);
    expect(res.rawPayload.toString()).toBe("stl:.stl:GLB[o Desk\nv 0 0 0\n]");
    expect(res.headers["content-type"]).toBe("model/stl");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves the result as a download named after the source, with a content-addressed ETag", async () => {
    const res = await get(`path=${encodeURIComponent("parts/Bracket Plate.obj")}&sha=${sha}&to=.STL`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('attachment; filename="Bracket Plate.stl"');
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''Bracket%20Plate.stl");
    // blob oid + source handler/build + target handler/build + target.
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{40}\.obj\.b0b0b0b\.stl\.5151515\.\.stl"$/);
    expect(res.headers["cache-control"]).toBe("public, no-cache");
  });

  it("revalidates to 304 and converts a blob once however often it is asked", async () => {
    const first = await get(`path=desk.obj&sha=${sha}&to=stl`);
    imports = [];
    const revalidated = await get(`path=desk.obj&sha=${sha}&to=stl`, { "if-none-match": first.headers["etag"] as string });
    expect(revalidated.statusCode).toBe(304);
    expect(imports).toHaveLength(0);
    expect((await get(`path=desk.obj&sha=${sha}&to=stl`)).statusCode).toBe(200);
    expect(imports).toHaveLength(0); // served from the cache
  });

  it("writes a format it cannot read (glTF is export-only here) and refuses to read it", async () => {
    expect((await get(`path=desk.obj&sha=${sha}&to=glb`)).statusCode).toBe(200);
    const res = await get(`path=model.glb&sha=${sha}&to=obj`);
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "unsupported-source" });
  });

  it("refuses targets and sources no official handler offers", async () => {
    const noTarget = await get(`path=desk.obj&sha=${sha}&to=dae`);
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json()).toMatchObject({ code: "unsupported-target" });
    // csv is a handler, but not a 3D one: it neither imports nor exports.
    expect((await get(`path=desk.obj&sha=${sha}&to=csv`)).json()).toMatchObject({ code: "unsupported-target" });
    expect((await get(`path=data.csv&sha=${sha}&to=stl`)).json()).toMatchObject({ code: "unsupported-source" });
    expect((await get(`path=notes.txt&sha=${sha}&to=stl`)).statusCode).toBe(415);
  });

  it("validates its parameters", async () => {
    expect((await get(`path=desk.obj&sha=${sha}`)).statusCode).toBe(400);
    expect((await get(`sha=${sha}&to=stl`)).statusCode).toBe(400);
    expect((await get(`path=desk.obj&sha=${sha}&to=${encodeURIComponent("../etc/passwd")}`)).statusCode).toBe(400);
    expect((await get(`path=nope.obj&sha=${sha}&to=stl`)).statusCode).toBe(404);
  });

  it("refuses a blob over the handler limit with the real size, without reading it", async () => {
    const res = await get(`path=big.obj&sha=${bigSha}&to=stl`);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ size: 8 * 1024 * 1024 + 1, limit: 8 * 1024 * 1024 });
    expect(imports).toHaveLength(0);
  });

  it("reports which side refused, as 422 and not a server fault", async () => {
    failImport = true;
    const a = await get(`path=desk.obj&sha=${sha}&to=stl`);
    expect(a.statusCode).toBe(422);
    expect(a.json()).toMatchObject({ stage: "import" });
    expect(a.json().message).toContain("invalid number");

    failImport = false;
    failExport = true;
    const b = await get(`path=desk.obj&sha=${sha}&to=stl`);
    expect(b.statusCode).toBe(422);
    expect(b.json()).toMatchObject({ stage: "export", message: expect.stringContaining("no triangles") });
  });

  it("hides a private repo from strangers and keeps its conversions out of shared caches", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    expect((await get(`path=desk.obj&sha=${sha}&to=stl`)).statusCode).toBe(404);
    const res = await get(`path=desk.obj&sha=${sha}&to=stl`, { authorization: await authHeader(app, "user-1") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });
});

describe("GET /convert/formats", () => {
  it("lists what the official handlers can read and write, and only that", async () => {
    const res = await app.inject({ method: "GET", url: "/convert/formats" });
    expect(res.statusCode).toBe(200);
    expect(res.json().formats).toEqual([
      { ext: ".glb", handlerId: "gltf-scene", canImport: false, canExport: true },
      { ext: ".obj", handlerId: "obj", canImport: true, canExport: true },
      { ext: ".stl", handlerId: "stl", canImport: true, canExport: true },
    ]);
  });
});

describe("officialWasmConvert", () => {
  it("holds the intermediate GLB to the handler cap, not just the source", async () => {
    __setOfficialHandlerForTests("obj", {
      ...transcoder("obj", [".obj"]),
      import: async () => ({ bytes: new Uint8Array(8 * 1024 * 1024 + 1) }),
    });
    const r = await officialWasmConvert("a.obj", ".stl", Buffer.from("x"));
    expect(r).toMatchObject({ kind: "too-large", limit: 8 * 1024 * 1024 });
    expect(exports).toHaveLength(0);
  });
});
