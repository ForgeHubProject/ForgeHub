/**
 * What the file page's header says about a file (#225): its size, read from
 * the tree rather than by downloading it, and its FHR format, when there is
 * one, with whether this repo has semantic diffs on for it.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("../fhr/official-handlers.js", () => ({
  officialHandlerId: vi.fn(async (ext: string) => ({ ".obj": "obj", ".glb": "gltf-scene" } as Record<string, string>)[ext] ?? null),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { officialHandlerId } from "../fhr/official-handlers.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

const MOCK_REPO = {
  id: "repo-1", name: "meta", visibility: "PUBLIC", storageKey: "acme/meta.git",
  ownerId: "owner", orgId: null, collaborators: [], teamAccess: [], org: null,
};

let repo: TestRepo;
let app: FastifyInstance;

beforeAll(async () => {
  repo = await createTestRepo("acme/meta.git");
  await makeCommit(repo.workDir, {
    "README.md": "# meta\n",
    ".forge/formats": ".obj\n",
    "models/trap.obj": "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
    "models/desk.glb": "glTF-ish bytes",
  }, "initial");
  await makeCommit(repo.workDir, { "models/trap.obj": "v 0 0 0\n" }, "smaller trap", "feature");
  app = await createTestServer();
});
afterAll(async () => { await app.close(); await repo.cleanup(); });
beforeEach(() => { vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never); });

const get = (qs: string) => app.inject({ method: "GET", url: `/repos/acme/meta/blob-meta?${qs}` });

describe("GET /repos/:handle/:name/blob-meta", () => {
  it("gives a text file's size and no format", async () => {
    const res = await get("ref=main&path=README.md");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ref: "main", path: "README.md", size: 7, format: null });
    expect(res.json().sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gives a handled format, with semantic diffs on when the repo opted in", async () => {
    const res = await get("ref=main&path=models%2Ftrap.obj");
    expect(res.json()).toMatchObject({ size: 32, format: { ext: ".obj", handlerId: "obj", semanticDiffs: true } });
  });

  it("names the handler but says semantic diffs are off when the repo hasn't opted in", async () => {
    const res = await get("ref=main&path=models%2Fdesk.glb");
    expect(res.json()).toMatchObject({ size: 14, format: { ext: ".glb", handlerId: "gltf-scene", semanticDiffs: false } });
  });

  it("reads the size at the ref, and defaults to the default branch", async () => {
    expect((await get("ref=feature&path=models%2Ftrap.obj")).json().size).toBe(8);
    expect((await get("path=models%2Ftrap.obj")).json()).toMatchObject({ ref: "main", size: 32 });
  });

  it("still answers when the FHR manifest is unreachable, without a format", async () => {
    vi.mocked(officialHandlerId).mockRejectedValueOnce(new Error("manifest 503"));
    const res = await get("ref=main&path=models%2Ftrap.obj");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ size: 32, format: null });
  });

  it("400 without a path; 404 for a missing file, a folder, an unknown or option-shaped ref", async () => {
    expect((await get("ref=main")).statusCode).toBe(400);
    expect((await get("ref=main&path=nope.txt")).statusCode).toBe(404);
    expect((await get("ref=main&path=models")).statusCode).toBe(404);
    expect((await get("ref=nope&path=README.md")).statusCode).toBe(404);
    expect((await get("ref=--output%3D%2Ftmp%2Fx&path=README.md")).statusCode).toBe(404);
  });

  it("404s a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    expect((await get("ref=main&path=README.md")).statusCode).toBe(404);
  });
});
