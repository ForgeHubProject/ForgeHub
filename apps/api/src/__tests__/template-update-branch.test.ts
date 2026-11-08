/**
 * Template repositories and "Update branch" (#256).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    pullRequest: { findFirst: vi.fn() },
    protectedBranch: { findFirst: vi.fn() },
  },
}));
vi.mock("../git-utils.js", async (orig) => ({
  ...(await orig<typeof import("../git-utils.js")>()),
  countAheadBehind: vi.fn(),
  performMerge: vi.fn(),
}));
vi.mock("../git-push-shared.js", async (orig) => ({
  ...(await orig<typeof import("../git-push-shared.js")>()),
  snapshotHeadShas: vi.fn().mockResolvedValue(new Map()),
  runPostReceiveEffects: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { countAheadBehind, performMerge } from "../git-utils.js";
import { runPostReceiveEffects } from "../git-push-shared.js";
import { createBareRepo } from "../git-storage.js";
import { seedFromTemplate } from "../repo-template.js";
import { authHeader, createTestServer } from "./helpers/server.js";
import { createTestRepo, makeCommit } from "./helpers/git.js";

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]) => execFile("git", args, { cwd }).then((r) => r.stdout.trim());

describe("seedFromTemplate", () => {
  let template: Awaited<ReturnType<typeof createTestRepo>>;
  beforeAll(async () => {
    template = await createTestRepo("acme/template.git");
  }, 30_000);
  afterAll(async () => {
    await template.cleanup();
  });

  it("starts a repository with one commit of the template's files and none of its history", async () => {
    const first = await makeCommit(template.workDir, { "README.md": "# Starter\n" }, "first");
    await makeCommit(template.workDir, { "src/index.ts": "export {};\n" }, "second");
    const newPath = await createBareRepo("ada/fresh.git");

    expect(await seedFromTemplate("ada/fresh.git", "acme/template.git", { name: "Ada", email: "ada@x.io" })).toBe("main");
    expect(await git(newPath, "log", "--format=%s|%an", "main")).toBe("Initial commit|Ada");
    expect(await git(newPath, "rev-parse", "main^{tree}")).toBe(await git(template.bareRepoPath, "rev-parse", "main^{tree}"));
    await expect(git(newPath, "cat-file", "-e", first)).rejects.toThrow();
    expect(await git(newPath, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("leaves a repository empty when the template has no commits", async () => {
    await createBareRepo("acme/empty-template.git");
    await createBareRepo("ada/from-empty.git");
    expect(await seedFromTemplate("ada/from-empty.git", "acme/empty-template.git", { name: "Ada", email: "ada@x.io" })).toBeNull();
  });
});

describe("Update branch", () => {
  const ME = "user-me";
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, ME);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      id: "r1", name: "poster", visibility: "PUBLIC", storageKey: "ada/poster.git", ownerId: ME, orgId: null, archivedAt: null,
      owner: { handle: "ada" }, org: null, collaborators: [], teamAccess: [],
    } as never);
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue({ id: "pr", number: 4, state: "OPEN", fromBranch: "headline", toBranch: "main" } as never);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null);
  });
  const update = () => app.inject({ method: "POST", url: "/repos/ada/poster/pulls/4/update-branch", headers: { authorization: token } });

  it("merges the base into the head and treats it as a push", async () => {
    vi.mocked(countAheadBehind).mockResolvedValue({ ahead: 1, behind: 2 });
    vi.mocked(performMerge).mockResolvedValue({ ok: true, sha: "abc" } as never);
    const res = await update();
    expect(res.json()).toEqual({ sha: "abc" });
    expect(performMerge).toHaveBeenCalledWith("ada/poster.git", "main", "headline", "Merge branch 'main' into headline");
    expect(runPostReceiveEffects).toHaveBeenCalled();
  });

  it("refuses an up-to-date branch, a head that only takes pull requests, and a conflict", async () => {
    vi.mocked(countAheadBehind).mockResolvedValue({ ahead: 1, behind: 0 });
    expect((await update()).statusCode).toBe(409);
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue({ requirePullRequest: true } as never);
    expect((await update()).json().error).toContain("protected");
    vi.mocked(prisma.protectedBranch.findFirst).mockResolvedValue(null);
    vi.mocked(countAheadBehind).mockResolvedValue({ ahead: 1, behind: 3 });
    vi.mocked(performMerge).mockResolvedValue({ ok: false } as never);
    expect((await update()).json().error).toContain("conflicts");
    expect(runPostReceiveEffects).not.toHaveBeenCalled();
  });
});
