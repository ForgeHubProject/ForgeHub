/**
 * Semantic file-diff endpoint tests. Uses a real bare git repo with committed
 * glTF blobs and a .forge/formats opt-in; prisma is mocked for repo visibility.
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
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

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
  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  await repo.cleanup();
  await app.close();
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
});

function get(query: string) {
  return app.inject({ method: "GET", url: `/repos/alice/scene/filediff?${query}` });
}

describe("GET /repos/:handle/:name/filediff", () => {
  it("returns a semantic StructuredDiff for a changed glTF file", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("gltf-scene");
    expect(body.handlerId).toBe("gltf-scene");
    // the Cube's translation changed base→head; the diff should be non-empty
    expect(Array.isArray(body.changes)).toBe(true);
    expect(JSON.stringify(body.changes)).toContain("Cube");
  });

  it("uses an explicit base when provided", async () => {
    const res = await get(`path=model.gltf&sha=${headSha}&base=${baseSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe("gltf-scene");
  });

  it("400s without required params", async () => {
    expect((await get(`sha=${headSha}`)).statusCode).toBe(400);
    expect((await get(`path=model.gltf`)).statusCode).toBe(400);
  });

  it("404s for a file whose extension is not in .forge/formats", async () => {
    const res = await get(`path=readme.md&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });

  it("404s for a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await get(`path=model.gltf&sha=${headSha}`);
    expect(res.statusCode).toBe(404);
  });
});
