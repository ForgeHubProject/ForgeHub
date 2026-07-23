import { vi, describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
//
// prisma is mocked so we can hand the fork routes repos whose `storageKey`
// points at REAL bare repos created below. git-utils and git-storage are left
// REAL so `syncForkBranch` performs genuine fetch / ahead-behind / fast-forward
// against those bare repos. push-events + ingest are mocked so we can assert the
// post-sync fan-out fires on a fast-forward and stays silent otherwise.

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ handle: "alice" }),
    },
    repo: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
  },
}));

vi.mock("../push-events.js", () => ({
  emitPushEvents: vi.fn(),
  ZERO_SHA: "0".repeat(40),
}));

vi.mock("../ingest.js", () => ({
  ingestCommitRange: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { emitPushEvents } from "../push-events.js";
import { ingestCommitRange } from "../ingest.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { cloneMirror, syncForkBranch } from "../git-utils.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import type { FastifyInstance } from "fastify";

const execFile = promisify(execFileCb);

const OWNER_ID = "user-owner";
const OTHER_ID = "user-other";
const PARENT_KEY = "parent/repo.git";
const FORK_KEY = "forks/fork.git";

/** Clone a bare repo into a throwaway work dir with git identity configured. */
async function cloneWork(bareKey: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fh-fork-work-"));
  await execFile("git", ["clone", bareRepoPathFromKey(bareKey), dir]);
  await execFile("git", ["-C", dir, "config", "user.email", "t@forgehub.io"]);
  await execFile("git", ["-C", dir, "config", "user.name", "Tester"]);
  await execFile("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  return dir;
}

/**
 * Fresh parent bare repo (with one seed commit) plus a mirror-clone fork under
 * the same storage root — the on-disk shape the fork route produces.
 */
async function makeForkPair(): Promise<TestRepo> {
  const parent = await createTestRepo(PARENT_KEY);
  await makeCommit(parent.workDir, { "README.md": "line 1\n" }, "init");
  await cloneMirror(PARENT_KEY, FORK_KEY);
  return parent;
}

function forkRepoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fork-1",
    name: "fork",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: FORK_KEY,
    ownerId: OWNER_ID,
    forkedFromId: "parent-1",
    collaborators: [],
    ...overrides,
  };
}

function parentRepoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "parent-1",
    name: "repo",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: PARENT_KEY,
    ownerId: OTHER_ID,
    forkedFromId: null,
    collaborators: [],
    ...overrides,
  };
}

// ─── syncForkBranch on real bare repos (unit) ─────────────────────────────────

describe("syncForkBranch (real bare repos)", () => {
  let parent: TestRepo;
  afterEach(async () => { await parent?.cleanup(); });

  it("up-to-date: fork already has the upstream tip", async () => {
    parent = await makeForkPair();
    const result = await syncForkBranch(FORK_KEY, PARENT_KEY);
    expect(result.status).toBe("up-to-date");
    expect(result.behind).toBe(0);
  });

  it("fast-forwarded: fork strictly behind advances to the upstream tip", async () => {
    parent = await makeForkPair();
    const newTip = await makeCommit(parent.workDir, { "README.md": "line 1\nline 2\n" }, "upstream change");

    const result = await syncForkBranch(FORK_KEY, PARENT_KEY);
    expect(result.status).toBe("fast-forwarded");
    expect(result.behind).toBe(1);
    expect(result.ahead).toBe(0);
    expect(result.newSha).toBe(newTip);

    // The fork's branch ref actually moved to the upstream tip.
    const { stdout } = await execFile("git", ["rev-parse", "refs/heads/main"], { cwd: bareRepoPathFromKey(FORK_KEY) });
    expect(stdout.trim()).toBe(newTip);
  });

  it("diverged: fork with local commits is reported, never rewound", async () => {
    parent = await makeForkPair();
    // Upstream advances…
    await makeCommit(parent.workDir, { "README.md": "line 1\nupstream\n" }, "upstream change");
    // …and the fork gains its own, different commit.
    const forkWork = await cloneWork(FORK_KEY);
    const forkTip = await makeCommit(forkWork, { "LOCAL.md": "local work\n" }, "fork change");

    const result = await syncForkBranch(FORK_KEY, PARENT_KEY);
    expect(result.status).toBe("diverged");
    expect(result.behind).toBe(1);
    expect(result.ahead).toBe(1);

    // The fork's branch is untouched — still at its own tip.
    const { stdout } = await execFile("git", ["rev-parse", "refs/heads/main"], { cwd: bareRepoPathFromKey(FORK_KEY) });
    expect(stdout.trim()).toBe(forkTip);
  });
});

// ─── fork routes (server) ─────────────────────────────────────────────────────

describe("fork routes", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "alice" } as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.repo.count).mockResolvedValue(0 as never);
  });

  // ── lineage set on fork ──
  describe("POST /repos/:handle/:name/fork", () => {
    it("records forkedFromId pointing at the source repo", async () => {
      const source = parentRepoRow({ id: "src-9", ownerId: OTHER_ID, storageKey: null });
      vi.mocked(prisma.repo.findFirst)
        .mockResolvedValueOnce(source as never) // resolveRepo(source)
        .mockResolvedValueOnce(null as never); // existing-name check
      vi.mocked(prisma.repo.create).mockResolvedValue({
        id: "fork-9", name: "repo", description: null, visibility: "PUBLIC",
        ownerId: OWNER_ID, storageKey: null, createdAt: new Date(),
      } as never);

      const res = await app.inject({
        method: "POST", url: "/repos/other/repo/fork",
        headers: { authorization: ownerToken },
      });

      expect(res.statusCode).toBe(201);
      const createArg = vi.mocked(prisma.repo.create).mock.calls[0][0];
      expect((createArg.data as { forkedFromId?: string }).forkedFromId).toBe("src-9");
      expect(res.json().parent).toEqual({ handle: "other", name: "repo" });
    });
  });

  // ── GET forks: visibility respected ──
  describe("GET /repos/:handle/:name/forks", () => {
    it("restricts to public forks for an anonymous caller", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(parentRepoRow({ id: "repo-1" }) as never);
      vi.mocked(prisma.repo.findMany).mockResolvedValue([] as never);

      const res = await app.inject({ method: "GET", url: "/repos/other/repo/forks" });
      expect(res.statusCode).toBe(200);
      const where = (vi.mocked(prisma.repo.findMany).mock.calls[0]![0] as { where: Record<string, unknown> }).where;
      expect(where.forkedFromId).toBe("repo-1");
      expect(where.visibility).toBe("PUBLIC");
      expect(where.OR).toBeUndefined();
    });

    it("widens to owned/collaborating forks for an authenticated caller", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(parentRepoRow({ id: "repo-1" }) as never);
      vi.mocked(prisma.repo.findMany).mockResolvedValue([
        { id: "f1", name: "fork", description: null, visibility: "PUBLIC", updatedAt: new Date(), owner: { handle: "bob" } },
      ] as never);

      const res = await app.inject({
        method: "GET", url: "/repos/other/repo/forks",
        headers: { authorization: ownerToken },
      });
      expect(res.statusCode).toBe(200);
      const where = (vi.mocked(prisma.repo.findMany).mock.calls[0]![0] as { where: Record<string, unknown> }).where;
      expect(where.OR).toBeDefined();
      expect(res.json().forks[0]).toMatchObject({ fullName: "bob/fork", visibility: "public" });
    });
  });

  // ── sync: guards ──
  describe("POST /repos/:handle/:name/sync (guards)", () => {
    it("400 when the repo is not a fork", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(forkRepoRow({ forkedFromId: null }) as never);
      const res = await app.inject({ method: "POST", url: "/repos/alice/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(400);
    });

    it("403 when the caller cannot write the fork", async () => {
      // Fork owned by someone else, public (readable) but caller isn't a writer.
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(forkRepoRow({ ownerId: OTHER_ID, collaborators: [] }) as never);
      const res = await app.inject({ method: "POST", url: "/repos/other/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(403);
    });

    it("404 when the upstream is not readable by the caller", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(forkRepoRow() as never);
      // Private parent the caller neither owns nor collaborates on.
      vi.mocked(prisma.repo.findUnique).mockResolvedValue(
        parentRepoRow({ visibility: "PRIVATE", ownerId: OTHER_ID, collaborators: [] }) as never,
      );
      const res = await app.inject({ method: "POST", url: "/repos/alice/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── sync: real-git states + side effects ──
  describe("POST /repos/:handle/:name/sync (fast-forward / up-to-date / diverged)", () => {
    let parent: TestRepo;
    afterEach(async () => { await parent?.cleanup(); });

    function wireRepos() {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(forkRepoRow() as never);
      vi.mocked(prisma.repo.findUnique).mockResolvedValue(parentRepoRow() as never);
    }

    async function tick() { await new Promise((r) => setImmediate(r)); }

    it("fast-forwarded → emits push events and re-ingests", async () => {
      parent = await makeForkPair();
      await makeCommit(parent.workDir, { "README.md": "line 1\nline 2\n" }, "upstream change");
      wireRepos();

      const res = await app.inject({ method: "POST", url: "/repos/alice/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "fast-forwarded", behind: 1, ahead: 0 });

      expect(vi.mocked(emitPushEvents)).toHaveBeenCalledTimes(1);
      const [rid, skey, sender, changed] = vi.mocked(emitPushEvents).mock.calls[0];
      expect(rid).toBe("fork-1");
      expect(skey).toBe(FORK_KEY);
      expect(sender).toBe(OWNER_ID);
      expect((changed as Array<{ branch: string }>)[0].branch).toBe("main");

      await tick();
      expect(vi.mocked(ingestCommitRange)).toHaveBeenCalledTimes(1);
    });

    it("up-to-date → no push events, no ingestion", async () => {
      parent = await makeForkPair();
      wireRepos();

      const res = await app.inject({ method: "POST", url: "/repos/alice/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "up-to-date", behind: 0 });

      await tick();
      expect(vi.mocked(emitPushEvents)).not.toHaveBeenCalled();
      expect(vi.mocked(ingestCommitRange)).not.toHaveBeenCalled();
    });

    it("diverged → no push events, no ingestion", async () => {
      parent = await makeForkPair();
      await makeCommit(parent.workDir, { "README.md": "line 1\nupstream\n" }, "upstream change");
      const forkWork = await cloneWork(FORK_KEY);
      await makeCommit(forkWork, { "LOCAL.md": "local\n" }, "fork change");
      wireRepos();

      const res = await app.inject({ method: "POST", url: "/repos/alice/fork/sync", headers: { authorization: ownerToken } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "diverged", behind: 1, ahead: 1 });

      await tick();
      expect(vi.mocked(emitPushEvents)).not.toHaveBeenCalled();
      expect(vi.mocked(ingestCommitRange)).not.toHaveBeenCalled();
    });
  });
});
