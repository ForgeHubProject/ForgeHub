/**
 * Every file path at a ref, for the file page's "Go to file" (#223). The list
 * is read straight from git, so the tests compare it with git itself, on real
 * repositories, including names a line-based reader would get wrong.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../prisma.js";
import { __resetRepoPathsCache, listPathsAtRef } from "../repo-paths.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

const execFile = promisify(execFileCb);

let repo: TestRepo;

beforeAll(async () => {
  repo = await createTestRepo("acme/paths.git");
  await makeCommit(repo.workDir, {
    "README.md": "# paths",
    "src/index.ts": "export {}",
    "src/deep/nested/file.go": "package nested",
    "models/desk v2.glb": "glb",
    "odd\nname.txt": "newline in a name",
    "ünïcode/ファイル.txt": "utf-8",
  }, "initial");
  await makeCommit(repo.workDir, { "only-on-feature.txt": "x" }, "feature work", "feature");
});
afterAll(async () => { await repo.cleanup(); });
beforeEach(() => { __resetRepoPathsCache(); });

async function gitPaths(ref: string): Promise<string[]> {
  const { stdout } = await execFile("git", ["-C", repo.bareRepoPath, "ls-tree", "-r", "-z", "--name-only", ref]);
  return stdout.split("\0").filter(Boolean);
}

describe("listPathsAtRef", () => {
  it("lists exactly what git lists, odd names included", async () => {
    const got = await listPathsAtRef(repo.storageKey, "main");
    expect(got?.paths).toEqual(await gitPaths("main"));
    expect(got?.paths).toContain("odd\nname.txt");
    expect(got?.paths).toContain("ünïcode/ファイル.txt");
    expect(got?.paths).toContain("models/desk v2.glb");
    expect(got?.truncated).toBe(false);
    expect(got?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("follows the ref, and defaults to the default branch", async () => {
    expect((await listPathsAtRef(repo.storageKey, "feature"))?.paths).toContain("only-on-feature.txt");
    const dflt = await listPathsAtRef(repo.storageKey);
    expect(dflt?.ref).toBe("main");
    expect(dflt?.paths).not.toContain("only-on-feature.txt");
  });

  it("stops at the limit and says so", async () => {
    const got = await listPathsAtRef(repo.storageKey, "main", 2);
    expect(got?.paths).toHaveLength(2);
    expect(got?.truncated).toBe(true);
  });

  it("is null for a ref that does not resolve, and refuses an option-shaped one", async () => {
    expect(await listPathsAtRef(repo.storageKey, "no-such-branch")).toBeNull();
    expect(await listPathsAtRef(repo.storageKey, "--output=/tmp/x")).toBeNull();
  });
});

describe("GET /repos/:handle/:name/paths", () => {
  let app: FastifyInstance;
  const MOCK_REPO = {
    id: "repo-1", name: "paths", visibility: "PUBLIC", storageKey: "acme/paths.git",
    ownerId: "owner", orgId: null, collaborators: [], teamAccess: [], org: null,
  };

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never); });

  it("returns the paths at a ref", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/acme/paths/paths?ref=feature" });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toEqual(await gitPaths("feature"));
  });

  it("404s for an unknown ref", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/acme/paths/paths?ref=nope" });
    expect(res.statusCode).toBe(404);
  });

  it("404s a private repo the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await app.inject({ method: "GET", url: "/repos/acme/paths/paths" });
    expect(res.statusCode).toBe(404);
  });
});
