/**
 * POST /contents (#254): web commits through the API, against a real repo.
 * The commit mechanics are web-commit.test.ts's; here, the route's rules:
 * who may commit, protected branches, sizes, and the push follow-ups.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    protectedBranch: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../git-push-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../git-push-shared.js")>()),
  runPostReceiveEffects: vi.fn().mockResolvedValue(undefined),
}));

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { runPostReceiveEffects } from "../git-push-shared.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const execFile = promisify(execFileCb);
const OWNER = "user-owner";
const MOCK_REPO = {
  id: "repo-1", name: "site", visibility: "PUBLIC", storageKey: "acme/site.git",
  ownerId: OWNER, orgId: null, collaborators: [], teamAccess: [], org: null,
};

let repo: TestRepo;
let app: FastifyInstance;
let token: string;
let tip: string;

beforeAll(async () => {
  repo = await createTestRepo("acme/site.git");
  tip = await makeCommit(repo.workDir, { "README.md": "# Site\n" }, "initial");
  app = await createTestServer();
  token = await authHeader(app, OWNER);
}, 30_000);
afterAll(async () => { await app.close(); await repo.cleanup(); });
beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "owner", displayName: "Olive Owner", email: "olive@forgehub.io" } as never);
  vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null as never);
  vi.mocked(runPostReceiveEffects).mockClear();
});

const post = (payload: object, auth: string | null = token) =>
  app.inject({ method: "POST", url: "/repos/acme/site/contents", headers: auth ? { authorization: auth } : {}, payload });
const show = async (ref: string, p: string) =>
  (await execFile("git", ["show", `${ref}:${p}`], { cwd: repo.bareRepoPath })).stdout;

describe("POST /repos/:handle/:name/contents", () => {
  it("commits a new file to the branch and runs the push follow-ups", async () => {
    const res = await post({
      branch: "main", expectedSha: tip, message: "Create docs/intro.md", description: "First page",
      changes: [{ path: "docs/intro.md", content: "Hello\n" }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ branch: "main", parent: tip });
    tip = res.json().sha;
    expect(await show("main", "docs/intro.md")).toBe("Hello\n");
    const { stdout } = await execFile("git", ["log", "-1", "--format=%an|%B", "main"], { cwd: repo.bareRepoPath });
    expect(stdout.trim()).toBe("Olive Owner|Create docs/intro.md\n\nFirst page");
    expect(runPostReceiveEffects).toHaveBeenCalledWith(
      expect.anything(), { id: "repo-1", storageKey: "acme/site.git" }, OWNER, repo.bareRepoPath, expect.any(Map),
    );
  });

  it("uploads base64 content byte for byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const res = await post({
      branch: "main", message: "Upload", changes: [{ path: "bin/data.bin", content: bytes.toString("base64"), encoding: "base64" }],
    });
    expect(res.statusCode).toBe(201);
    const { stdout } = await execFile("git", ["show", "main:bin/data.bin"], { cwd: repo.bareRepoPath, encoding: "buffer" });
    expect(Buffer.compare(stdout, bytes)).toBe(0);
  });

  it("refuses a protected branch, and allows a new branch from it", async () => {
    vi.mocked(prisma.protectedBranch.findFirst).mockImplementation((async (args: { where: { branch: string } }) =>
      args.where.branch === "main" ? { requirePullRequest: true } : null) as never);
    const direct = await post({ branch: "main", message: "x", changes: [{ path: "x.txt", content: "x" }] });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().protection).toBe(true);

    const proposal = await post({ branch: "main", newBranch: "owner-patch-1", message: "x", changes: [{ path: "x.txt", content: "x" }] });
    expect(proposal.statusCode).toBe(201);
    expect(proposal.json().branch).toBe("owner-patch-1");
    expect(await show("owner-patch-1", "x.txt")).toBe("x");
  });

  it("refuses a stale edit with 409 and a missing file with 404", async () => {
    const stale = await post({ branch: "main", expectedSha: "0".repeat(40), message: "x", changes: [{ path: "README.md", content: "late" }] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().reason).toBe("moved");
    const missing = await post({ branch: "main", message: "x", changes: [{ path: "nope.txt", delete: true }] });
    expect(missing.statusCode).toBe(404);
  });

  it("checks the request: message, changes, sizes, sign-in and write access", async () => {
    expect((await post({ branch: "main", message: " ", changes: [{ path: "a", content: "a" }] })).statusCode).toBe(400);
    expect((await post({ branch: "main", message: "x", changes: [] })).statusCode).toBe(400);
    expect((await post({ branch: "main", message: "x", changes: [{ path: "a" }] })).statusCode).toBe(400);
    expect((await post({ branch: "main", newBranch: "bad name", message: "x", changes: [{ path: "a", content: "a" }] })).statusCode).toBe(400);
    const big = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    expect((await post({ branch: "main", message: "x", changes: [{ path: "big", content: big, encoding: "base64" }] })).statusCode).toBe(413);
    expect((await post({ branch: "main", message: "x", changes: [{ path: "a", content: "a" }] }, null)).statusCode).toBe(401);
    const stranger = await authHeader(app, "stranger");
    expect((await post({ branch: "main", message: "x", changes: [{ path: "a", content: "a" }] }, stranger)).statusCode).toBe(403);
  });
});
