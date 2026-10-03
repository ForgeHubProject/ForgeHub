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
import { bareRepoPathFromKey } from "../git-storage.js";
import {
  MAX_WALK,
  __resetTreeCommitsCache,
  __verifications,
  entryFor,
  getTreeCommits,
  parseLogRecord,
} from "../tree-commits.js";
import {
  createDeepHistoryRepo,
  createMergeHistoryRepo,
  createMergedAwayRepo,
  createTestRepo,
  makeCommit,
  type TestRepo,
} from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

const execFile = promisify(execFileCb);

describe("parseLogRecord", () => {
  it("reads the commit and the paths it changed, raw", () => {
    const sha = "a".repeat(40);
    expect(parseLogRecord(`${sha}\x1f2026-10-01T10:00:00+00:00\x1ffix: legs\0\nparts/leg.obj\0odd\nname.txt\0`)).toEqual({
      commit: { sha, date: "2026-10-01T10:00:00+00:00", subject: "fix: legs" },
      paths: ["parts/leg.obj", "odd\nname.txt"],
    });
  });

  it("reads a merge, which lists no paths, and rejects junk", () => {
    const sha = "b".repeat(40);
    expect(parseLogRecord(`${sha}\x1f2026-10-01T10:00:00+00:00\x1fMerge side\0`)?.paths).toEqual([]);
    expect(parseLogRecord("not a commit\0")).toBeNull();
  });
});

describe("entryFor", () => {
  it("names the entry directly under the directory", () => {
    expect(entryFor("", "README.md")).toBe("README.md");
    expect(entryFor("", "parts/legs/leg.obj")).toBe("parts");
    expect(entryFor("parts", "parts/legs/leg.obj")).toBe("legs");
    expect(entryFor("parts/legs", "parts/legs/leg.obj")).toBe("leg.obj");
  });

  it("is null outside the directory, including a sibling sharing its prefix", () => {
    expect(entryFor("parts", "docs/a.md")).toBeNull();
    expect(entryFor("parts", "parts-old/a.md")).toBeNull();
  });
});

/** `git log -1 --format=%H <ref> -- <path>` in the bare repo: what every entry must match. */
async function reference(storageKey: string, ref: string, path: string): Promise<string> {
  const { stdout } = await execFile("git", ["--literal-pathspecs", "log", "-1", "--format=%H", ref, "--", path], {
    cwd: bareRepoPathFromKey(storageKey),
  });
  return stdout.trim();
}

async function expectMatchesGit(storageKey: string, ref: string, dir: string) {
  const result = await getTreeCommits(storageKey, dir, ref);
  expect(result).not.toBeNull();
  const { stdout } = await execFile("git", ["ls-tree", "--name-only", ref, ...(dir ? [`${dir}/`] : [])], {
    cwd: bareRepoPathFromKey(storageKey),
  });
  const names = stdout.split("\n").filter(Boolean).map((p) => (dir ? p.slice(dir.length + 1) : p));
  expect(Object.keys(result!.commits).sort()).toEqual([...names].sort());
  for (const n of names) {
    expect(result!.commits[n].sha, `${dir || "(root)"} → ${n}`).toBe(await reference(storageKey, ref, dir ? `${dir}/${n}` : n));
  }
  return result!;
}

// ─── a working repository with folders, spaces and a mixed merge ──────────────
//
//   main: init ── top ── legs ─────────── leg again ── M ── readme tweak
//                        ╲                            ╱
//   side:                 top on side ── doc on side ─
//
// M takes `top on side` and `doc on side`, keeps main's legs.

let repo: TestRepo;
let app: FastifyInstance;
let main: string;

const MOCK_REPO = { id: "repo-1", name: "desk", ownerId: "owner-1", visibility: "PUBLIC", storageKey: "", collaborators: [] };

beforeAll(async () => {
  repo = await createTestRepo("test/tree-commits.git");
  await makeCommit(repo.workDir, {
    "README.md": "desk",
    "parts/top.obj": "o Top\n",
    "parts/legs/leg front.obj": "o Leg\n",
    "parts/legs/leg back.obj": "o Leg\n",
    "docs/assembly notes.md": "v1",
  }, "init");
  await makeCommit(repo.workDir, { "parts/top.obj": "o Top\nv 1 1 1\n" }, "top");
  await makeCommit(repo.workDir, { "parts/legs/leg front.obj": "o Leg\nv 0 0 0\n" }, "legs");
  const { stdout } = await execFile("git", ["-C", repo.workDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  main = stdout.trim();

  await makeCommit(repo.workDir, { "parts/top.obj": "o Top\nv 2 2 2\n" }, "top on side", "side");
  await makeCommit(repo.workDir, { "docs/assembly notes.md": "v2" }, "doc on side");
  await execFile("git", ["-C", repo.workDir, "checkout", main]);
  await makeCommit(repo.workDir, { "parts/legs/leg back.obj": "o Leg\nv 9 9 9\n" }, "leg again");
  await execFile("git", ["-C", repo.workDir, "merge", "--no-ff", "side", "-m", "M"]);
  await execFile("git", ["-C", repo.workDir, "push", "origin", "HEAD"]);
  await makeCommit(repo.workDir, { "README.md": "desk, assembled" }, "readme tweak");

  MOCK_REPO.storageKey = repo.storageKey;
  app = await createTestServer();
}, 60_000);

afterAll(async () => {
  await app.close();
  await repo.cleanup();
});

beforeEach(() => {
  __resetTreeCommitsCache();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
});

describe("getTreeCommits — every entry is what `git log -1 -- <entry>` says", () => {
  it("at the root", async () => {
    const r = await expectMatchesGit(repo.storageKey, main, "");
    expect(r.commits["README.md"].subject).toBe("readme tweak");
    expect(r.complete).toBe(true);
  });

  it("in a folder, across the merge", async () => {
    const r = await expectMatchesGit(repo.storageKey, main, "parts");
    expect(r.commits["top.obj"].subject).toBe("top on side");
    expect(r.commits["legs"].subject).toBe("leg again");
  });

  it("in a nested folder, names with spaces included", async () => {
    const r = await expectMatchesGit(repo.storageKey, main, "parts/legs");
    expect(r.commits["leg front.obj"].subject).toBe("legs");
    expect(r.commits["leg back.obj"].subject).toBe("leg again");
  });

  it("counts the commits the ref reaches", async () => {
    const r = await getTreeCommits(repo.storageKey, "", main);
    const { stdout } = await execFile("git", ["rev-list", "--count", main], { cwd: repo.bareRepoPath });
    expect(r?.totalCommits).toBe(Number(stdout.trim()));
  });

  it("caches per commit and path", async () => {
    const a = await getTreeCommits(repo.storageKey, "parts", main);
    const b = await getTreeCommits(repo.storageKey, "parts", main);
    expect(b?.commits).toBe(a?.commits);
  });

  it("is null for a ref that isn't one, including one shaped like an option", async () => {
    expect(await getTreeCommits(repo.storageKey, "", "no-such-branch")).toBeNull();
    expect(await getTreeCommits(repo.storageKey, "", "--output=/tmp/x")).toBeNull();
  });
});

describe("getTreeCommits — the histories one walk can get wrong", () => {
  it("never credits a side edit a merge threw away", async () => {
    const key = await createMergedAwayRepo("test/merged-away.git", "main", "part.obj");
    const r = await expectMatchesGit(key, "main", "");
    expect(r.commits["part.obj"].subject).toBe("REAL main edit");
  });

  it("follows a merge's second parent to the only commit that touched a file", async () => {
    const key = await createMergeHistoryRepo("test/merge-history.git", "main", 40, "rare.obj", "churn.obj");
    await expectMatchesGit(key, "main", "");
  });

  it("needs no per-entry re-ask on a history without merges", async () => {
    const key = await createDeepHistoryRepo("test/linear.git", "main", 50, "first.obj", "churn.obj");
    const before = __verifications;
    await expectMatchesGit(key, "main", "");
    expect(__verifications).toBe(before);
  });

  it(`stops after ${MAX_WALK} commits and leaves out what it hasn't reached`, async () => {
    const key = await createDeepHistoryRepo("test/deep.git", "main", MAX_WALK + 500, "oldest.obj", "churn.obj");
    const r = await getTreeCommits(key, "", "main");
    expect(r?.commits["churn.obj"]).toBeDefined();
    expect(r?.commits["oldest.obj"]).toBeUndefined();
    expect(r?.complete).toBe(false);
  }, 30_000);
});

describe("GET /repos/:handle/:name/tree-commits", () => {
  it("answers for a folder", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/o/desk/tree-commits?ref=${main}&path=parts/legs` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("parts/legs");
    expect(body.commits["leg back.obj"]).toMatchObject({ subject: "leg again" });
    expect(body.commits["leg back.obj"].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is a 404 on a private repository the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const res = await app.inject({ method: "GET", url: "/repos/o/desk/tree-commits" });
    expect(res.statusCode).toBe(404);
  });

  it("is empty, not an error, for a ref that does not resolve", async () => {
    const body = (await app.inject({ method: "GET", url: "/repos/o/desk/tree-commits?ref=nope" })).json();
    expect(body).toEqual({ ref: "nope", sha: null, path: "", commits: {}, complete: true, totalCommits: 0 });
  });
});
