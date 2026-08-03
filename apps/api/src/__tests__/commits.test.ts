/**
 * Commit history & file browser tests.
 *
 * Uses a real bare git repo (no git-utils mock) so we validate the actual
 * git plumbing. Prisma is mocked to control repo visibility and auth.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

// ─── Prisma mock (hoisted) ────────────────────────────────────────────────────
// Only mock what resolveRepo and auth routes touch; git-utils is NOT mocked.

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    repoCollaborator: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
    pullRequest: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    snapshot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    entity: { findMany: vi.fn().mockResolvedValue([]) },
    constraint: { findMany: vi.fn().mockResolvedValue([]) },
    tag: { findMany: vi.fn() },
    issue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    issueComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    issueLabel: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    label: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReview: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequestReviewComment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { listCommits, getCommit, listTree, defaultBranch } from "../git-utils.js";
import {
  bareRepoPathFromKey, createDeepHistoryRepo, createMergeHistoryRepo, createMergedAwayRepo,
  createTestRepo, makeCommit, checkoutBranch, type TestRepo,
} from "./helpers/git.js";
import { createTestServer, authHeader } from "./helpers/server.js";

// ─── Repo + server setup ──────────────────────────────────────────────────────

let repo: TestRepo;
let app: FastifyInstance;
let sha1: string;
let sha2: string;
let sha3feature: string;
let defBranch: string; // detected from the test repo (master or main)

const MOCK_REPO = {
  id: "repo-1",
  name: "my-repo",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string, // filled in beforeAll
  collaborators: [],
} as const;

const MOCK_PRIVATE_REPO = { ...MOCK_REPO, visibility: "PRIVATE" } as const;

beforeAll(async () => {
  repo = await createTestRepo("test/commits.git");

  // Commits on default branch
  sha1 = await makeCommit(
    repo.workDir,
    { "readme.txt": "hello world", "src/main.ts": "console.log('hello')" },
    "init: add readme and src/main.ts",
  );
  sha2 = await makeCommit(
    repo.workDir,
    { "readme.txt": "hello world updated" },
    "docs: update readme",
  );

  defBranch = await defaultBranch(repo.storageKey);

  // One commit on a feature branch
  await checkoutBranch(repo.workDir, "feature/cfg");
  sha3feature = await makeCommit(
    repo.workDir,
    { "config.json": '{"key":"value"}' },
    "feat: add config",
  );

  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
  (MOCK_PRIVATE_REPO as { storageKey: string }).storageKey = repo.storageKey;

  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  await repo.cleanup();
  await app.close();
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
});

// ─── git-utils: listCommits ───────────────────────────────────────────────────

describe("listCommits()", () => {
  it("returns commits on the default branch in reverse-chronological order", async () => {
    const commits = await listCommits(repo.storageKey, defBranch);
    expect(commits.length).toBe(2);
    expect(commits[0]!.sha).toBe(sha2);
    expect(commits[1]!.sha).toBe(sha1);
  });

  it("includes author, message, and date fields", async () => {
    const [latest] = await listCommits(repo.storageKey, defBranch);
    expect(latest!.message).toBe("docs: update readme");
    expect(latest!.authorName).toBeTruthy();
    expect(latest!.authorEmail).toBeTruthy();
    expect(latest!.date).toMatch(/^\d{4}-/);
    expect(latest!.shortSha).toHaveLength(7);
  });

  it("respects per-page pagination", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { perPage: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(sha2);
  });

  it("returns the second page correctly", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { perPage: 1, page: 2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(sha1);
  });

  it("returns commits on a feature branch (includes feature commit + base)", async () => {
    const commits = await listCommits(repo.storageKey, "feature/cfg");
    expect(commits.length).toBe(3);
    expect(commits[0]!.sha).toBe(sha3feature);
  });

  it("returns empty array for unknown ref", async () => {
    const commits = await listCommits(repo.storageKey, "nonexistent-branch");
    expect(commits).toEqual([]);
  });

  it("filters history to commits touching a file path", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { path: "src/main.ts" });
    expect(commits.map((c) => c.sha)).toEqual([sha1]);
  });

  it("filters history to commits touching a directory path", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { path: "src" });
    expect(commits.map((c) => c.sha)).toEqual([sha1]);
  });

  it("combines a path filter with pagination", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { path: "readme.txt", perPage: 1, page: 2 });
    expect(commits.map((c) => c.sha)).toEqual([sha1]);
  });

  it("returns empty array for a path no commit touches", async () => {
    const commits = await listCommits(repo.storageKey, defBranch, { path: "no/such/file.txt" });
    expect(commits).toEqual([]);
  });
});

// ─── git-utils: per-path history is git's own history simplification ──────────
//
// `RepoCodeTab` issues `{ path, perPage: 1 }` and reads element 0 as the
// directory's header commit — author, subject, short SHA, relative time, and the
// CI badge keyed off that SHA — so the only correct answer is the commit
// `git log -1 <ref> -- <path>` names. A linear chain cannot check that: every
// candidate rule agrees on a chain. These cases run on merge topologies, where
// the rules come apart, and take git itself as the oracle.

const execFile = promisify(execFileCb);
const gitSays = async (bare: string, args: string[]): Promise<string> => {
  const { stdout } = await execFile("git", ["-C", bare, ...args]);
  return stdout.trim();
};

describe("listCommits() per-path history follows git's TREESAME parent", () => {
  let key: string;
  let bare: string;

  beforeAll(async () => {
    // src/app.ts edited on main, edited again on a side branch, merged keeping
    // ours — so the side edit touches the path but its content is not in the
    // tree, and it is dated *newer* than the edit that did land.
    key = await createMergedAwayRepo("test/merged-away.git", "main", "src/app.ts");
    bare = bareRepoPathFromKey(key);
  }, 30_000);

  it("names the commit whose change is in the tree, not the one merged away", async () => {
    const expected = await gitSays(bare, ["log", "-1", "main", "--format=%H %s", "--", "src/app.ts"]);
    const [head] = await listCommits(key, "main", { path: "src/app.ts", perPage: 1 });
    expect(`${head?.sha} ${head?.subject}`).toBe(expected);
    expect(head?.subject).toBe("REAL main edit");
  });

  it("does the same for a directory — the code tab's actual call shape", async () => {
    const expected = await gitSays(bare, ["log", "-1", "main", "--format=%H %s", "--", "src"]);
    const [head] = await listCommits(key, "main", { path: "src", perPage: 1 });
    expect(`${head?.sha} ${head?.subject}`).toBe(expected);
    expect(head?.subject).toBe("REAL main edit");
  });

  it("keeps the merged-away commit out of the whole page, not just the head", async () => {
    const expected = (await gitSays(bare, ["log", "main", "--format=%s", "--", "src/app.ts"])).split("\n");
    const subjects = (await listCommits(key, "main", { path: "src/app.ts", perPage: 20 })).map((c) => c.subject);
    expect(subjects).toEqual(expected);
    expect(subjects).not.toContain("DISCARDED side edit");
  });
});

// ─── git-utils: history simplification reaches through a merge's 2nd parent ───
//
// The other half of following TREESAME parents: when the path's content came in
// from the *second* parent, git crosses into that lineage rather than staying on
// the mainline. Any scheme that only considers a window of the newest commits,
// or only the first-parent line, reports nothing here.

describe("listCommits() per-path history crosses a merge's second parent", () => {
  const PER_LINEAGE = 150;
  let mergeKey: string;
  let bare: string;

  beforeAll(async () => {
    mergeKey = await createMergeHistoryRepo(
      "test/merge-history.git", "main", PER_LINEAGE, "rare.txt", "churn.txt",
    );
    bare = bareRepoPathFromKey(mergeKey);
  }, 60_000);

  it("finds a path only the older lineage touches", async () => {
    // rare.txt is written solely by the root of the second lineage — the oldest
    // commit in the repo, reachable only across the merge.
    const expected = await gitSays(bare, ["log", "-1", "main", "--format=%H %s", "--", "rare.txt"]);
    const [head] = await listCommits(mergeKey, "main", { path: "rare.txt", perPage: 1 });
    expect(`${head?.sha} ${head?.subject}`).toBe(expected);
    expect(head?.subject).toBe("b0");
  });

  it("names the newest commit for a path the mainline churns", async () => {
    const expected = await gitSays(bare, ["log", "-1", "main", "--format=%H %s", "--", "churn.txt"]);
    const [head] = await listCommits(mergeKey, "main", { path: "churn.txt", perPage: 1 });
    expect(`${head?.sha} ${head?.subject}`).toBe(expected);
    expect(head?.subject).toBe(`a${PER_LINEAGE - 1}`);
  });
});

// ─── git-utils: the per-path bound is wall-clock, not commit count ────────────
//
// `/repos/:h/:r/commits` is unauthenticated for public repos, so one request
// must not be able to walk a whole DAG unattended. The bound is a timeout on the
// git process: it can cut a read short, but it can never make a read name a
// different commit than git does. A commit-count cap can, which is why there
// isn't one — a long-dormant path is still answered correctly, however deep.

describe("listCommits() per-path bound", () => {
  const DEPTH = 2050;
  let deepKey: string;
  let bare: string;

  beforeAll(async () => {
    deepKey = await createDeepHistoryRepo("test/deep-history.git", "main", DEPTH, "ancient.txt", "churn.txt");
    bare = bareRepoPathFromKey(deepKey);
  }, 30_000);

  afterEach(() => {
    delete process.env["PATH_HISTORY_TIMEOUT_MS"];
  });

  it("finds a path touched only by the oldest of thousands of commits", async () => {
    const expected = await gitSays(bare, ["log", "-1", "main", "--format=%H %s", "--", "ancient.txt"]);
    const [head] = await listCommits(deepKey, "main", { path: "ancient.txt", perPage: 1 });
    expect(`${head?.sha} ${head?.subject}`).toBe(expected);
    expect(head?.subject).toBe("c0");
  });

  it("serves a deep page of a path with thousands of matches", async () => {
    const expected = await gitSays(bare, ["log", "--skip=1999", "-n", "1", "main", "--format=%s", "--", "churn.txt"]);
    const commits = await listCommits(deepKey, "main", { path: "churn.txt", perPage: 1, page: 2000 });
    expect(commits.map((c) => c.subject)).toEqual([expected]);
    expect(expected).toBe("c50");
  });

  it("returns an empty page when the walk exceeds the timeout", async () => {
    process.env["PATH_HISTORY_TIMEOUT_MS"] = "1";
    expect(await listCommits(deepKey, "main", { path: "ancient.txt", perPage: 1 })).toEqual([]);
  });

  it("leaves unfiltered pagination alone at the same timeout", async () => {
    // The bound exists for path reads; an unfiltered page already costs only
    // skip + perPage commits and must not be cut short.
    process.env["PATH_HISTORY_TIMEOUT_MS"] = "1";
    const commits = await listCommits(deepKey, "main", { perPage: 1, page: DEPTH });
    expect(commits.map((c) => c.subject)).toEqual(["c0"]);
  });
});

// ─── git-utils: getCommit ─────────────────────────────────────────────────────

describe("getCommit()", () => {
  it("returns full commit metadata by SHA", async () => {
    const commit = await getCommit(repo.storageKey, sha2);
    expect(commit).not.toBeNull();
    expect(commit!.sha).toBe(sha2);
    expect(commit!.message).toBe("docs: update readme");
    expect(commit!.shortSha).toHaveLength(7);
    expect(commit!.parents).toContain(sha1);
  });

  it("includes changedFiles listing which files were modified", async () => {
    const commit = await getCommit(repo.storageKey, sha2);
    expect(commit!.changedFiles).toContain("readme.txt");
    expect(commit!.changedFiles).not.toContain("src/main.ts");
  });

  it("initial commit has empty parents", async () => {
    const commit = await getCommit(repo.storageKey, sha1);
    expect(commit!.parents).toEqual([]);
  });

  it("returns null for an unknown SHA", async () => {
    const commit = await getCommit(repo.storageKey, "0".repeat(40));
    expect(commit).toBeNull();
  });
});

// ─── git-utils: listTree ─────────────────────────────────────────────────────

describe("listTree()", () => {
  it("lists root entries", async () => {
    const entries = await listTree(repo.storageKey, defBranch, "");
    const names = entries.map((e) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).toContain("src");
  });

  it("root entry for src/ has type tree", async () => {
    const entries = await listTree(repo.storageKey, defBranch, "");
    const src = entries.find((e) => e.name === "src");
    expect(src?.type).toBe("tree");
  });

  it("lists contents of a subdirectory", async () => {
    const entries = await listTree(repo.storageKey, defBranch, "src");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("main.ts");
    expect(entries[0]!.type).toBe("blob");
    expect(entries[0]!.path).toBe("src/main.ts");
  });

  it("returns empty array for nonexistent path", async () => {
    const entries = await listTree(repo.storageKey, defBranch, "does-not-exist");
    expect(entries).toEqual([]);
  });
});

// ─── HTTP: GET /commits list ──────────────────────────────────────────────────

describe("GET /repos/:h/:r/commits", () => {
  it("returns commits with pagination metadata", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/commits?branch=${encodeURIComponent(defBranch)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commits).toHaveLength(2);
    expect(body.page).toBe(1);
    expect(body.perPage).toBe(20);
    expect(body.branch).toBe(defBranch);
  });

  it("respects ?per_page and ?page query params", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/commits?branch=${encodeURIComponent(defBranch)}&per_page=1&page=2` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0].sha).toBe(sha1);
  });

  it("filters by ?branch", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/commits?branch=feature%2Fcfg" });
    expect(res.statusCode).toBe(200);
    expect(res.json().commits).toHaveLength(3);
  });

  it("filters by ?path and echoes it in the payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/repos/alice/my-repo/commits?branch=${encodeURIComponent(defBranch)}&path=${encodeURIComponent("src/main.ts")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("src/main.ts");
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0].sha).toBe(sha1);
  });

  it("treats a blank ?path as no filter", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/commits?branch=${encodeURIComponent(defBranch)}&path=` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBeNull();
    expect(body.commits).toHaveLength(2);
  });

  it("returns 404 for unknown repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/repos/nobody/no-repo/commits" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for guest on private repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(MOCK_PRIVATE_REPO as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/commits" });
    expect(res.statusCode).toBe(404);
  });

  it("allows owner to read private repo commits", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValueOnce(MOCK_PRIVATE_REPO as never);
    const auth = await authHeader(app, "user-1");
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/commits",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── HTTP: GET /commits/:sha ──────────────────────────────────────────────────

describe("GET /repos/:h/:r/commits/:sha", () => {
  it("returns commit metadata and changedFiles", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/commits/${sha2}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sha).toBe(sha2);
    expect(body.message).toBe("docs: update readme");
    expect(body.changedFiles).toContain("readme.txt");
    expect(body.parents).toContain(sha1);
  });

  it("returns 404 for unknown SHA", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/commits/${"0".repeat(40)}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── HTTP: GET /tree/:ref ─────────────────────────────────────────────────────

describe("GET /repos/:h/:r/tree/:ref", () => {
  it("lists root entries at branch tip", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/tree/${defBranch}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("");
    expect(body.ref).toBe(defBranch);
    const names = (body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).toContain("src");
  });

  it("works with a full commit SHA as ref", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/tree/${sha1}` });
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown ref", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/tree/no-such-ref" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── HTTP: GET /tree/:ref/* ───────────────────────────────────────────────────

describe("GET /repos/:h/:r/tree/:ref/*", () => {
  it("lists a subdirectory", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/tree/${defBranch}/src` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("src");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].name).toBe("main.ts");
    expect(body.entries[0].type).toBe("blob");
  });

  it("returns 404 for nonexistent subdirectory", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/tree/${defBranch}/nonexistent` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── HTTP: GET /blob/:ref/* ───────────────────────────────────────────────────

describe("GET /repos/:h/:r/blob/:ref/*", () => {
  it("returns raw file content as text/plain", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/blob/${defBranch}/readme.txt` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("hello world");
  });

  it("reads a file in a subdirectory", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/blob/${defBranch}/src/main.ts` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("returns the correct content at an older commit SHA", async () => {
    // sha1 has "hello world" (without "updated")
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/blob/${sha1}/readme.txt` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello world");
  });

  it("returns 404 for a nonexistent file", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/blob/${defBranch}/does-not-exist.txt` });
    expect(res.statusCode).toBe(404);
  });
});
