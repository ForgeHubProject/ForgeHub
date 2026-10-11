import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../prisma.js";
import { __resetContributorsCache, getAuthorTallies, tallyShortlog } from "../contributors.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const execFile = promisify(execFileCb);

describe("tallyShortlog", () => {
  it("folds one email's spellings into one contributor, under the name used most", () => {
    const out = [
      "     5\tAda Lovelace <ada@example.com>",
      "     2\tada <ADA@example.com>",
      "     3\tCharles Babbage <cb@example.com>",
      "garbage line",
    ].join("\n");
    expect(tallyShortlog(out)).toEqual([
      { email: "ada@example.com", name: "Ada Lovelace", commits: 7 },
      { email: "cb@example.com", name: "Charles Babbage", commits: 3 },
    ]);
  });

  it("is empty for empty output", () => {
    expect(tallyShortlog("")).toEqual([]);
  });
});

// ─── a real history ───────────────────────────────────────────────────────────
//
//   main:  A A (ada) ── A (ada, as "ada l") ── B (bob) ── M (merge, by carol)
//                                                      ╲  ╱
//   side:                                               B (bob)
//
// Carol only clicked merge: --no-merges must leave her out.

let repo: TestRepo;
let app: FastifyInstance;
let mainBranch: string;

async function as(name: string, email: string) {
  await execFile("git", ["-C", repo.workDir, "config", "user.name", name]);
  await execFile("git", ["-C", repo.workDir, "config", "user.email", email]);
}

const MOCK_REPO = {
  id: "repo-1",
  name: "parts",
  ownerId: "owner-1",
  visibility: "PUBLIC",
  storageKey: "",
  collaborators: [
    { userId: "bob-1", role: "WRITER" },
    { userId: "eve-1", role: "READER" },
  ],
};

beforeAll(async () => {
  repo = await createTestRepo("test/contributors.git");
  await as("Ada Lovelace", "Ada@Example.com");
  await makeCommit(repo.workDir, { "a.txt": "1" }, "ada one");
  await makeCommit(repo.workDir, { "a.txt": "1b" }, "ada one more");
  await as("ada l", "ada@example.com");
  await makeCommit(repo.workDir, { "a.txt": "2" }, "ada two");
  const { stdout } = await execFile("git", ["-C", repo.workDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  mainBranch = stdout.trim();

  await as("Bob Builder", "bob@example.com");
  await makeCommit(repo.workDir, { "b.txt": "side" }, "bob on side", "side");
  await execFile("git", ["-C", repo.workDir, "checkout", mainBranch]);
  await makeCommit(repo.workDir, { "c.txt": "main" }, "bob on main");

  await as("Carol Merger", "carol@example.com");
  await execFile("git", ["-C", repo.workDir, "merge", "--no-ff", "side", "-m", "Merge side"]);
  await execFile("git", ["-C", repo.workDir, "push", "origin", "HEAD"]);

  MOCK_REPO.storageKey = repo.storageKey;
  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  await app.close();
  await repo.cleanup();
});

beforeEach(() => {
  __resetContributorsCache();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]);
});

describe("getAuthorTallies", () => {
  it("counts authors, folding case and spelling, leaving out merge commits", async () => {
    const result = await getAuthorTallies(repo.storageKey);
    expect(result?.ref).toBe(mainBranch);
    expect(result?.tallies).toEqual([
      { email: "ada@example.com", name: "Ada Lovelace", commits: 3 },
      { email: "bob@example.com", name: "Bob Builder", commits: 2 },
    ]);
  });

  it("caches per commit", async () => {
    const first = await getAuthorTallies(repo.storageKey, mainBranch);
    const second = await getAuthorTallies(repo.storageKey, mainBranch);
    expect(second?.tallies).toBe(first?.tallies);
  });

  it("follows the ref asked for", async () => {
    const side = await getAuthorTallies(repo.storageKey, "side");
    expect(side?.tallies.map((t) => [t.name, t.commits])).toEqual([
      ["Ada Lovelace", 3],
      ["Bob Builder", 1],
    ]);
  });

  it("is null for a ref that isn't one, including one shaped like an option", async () => {
    expect(await getAuthorTallies(repo.storageKey, "no-such-branch")).toBeNull();
    expect(await getAuthorTallies(repo.storageKey, "--output=/tmp/x")).toBeNull();
  });
});

describe("GET /repos/:handle/:name/contributors", () => {
  const accounts = [
    { id: "owner-1", email: "ada@example.com", handle: "ada", displayName: "Ada", avatarKey: "k1" },
    { id: "bob-1", email: "bob@example.com", handle: "bob", displayName: null, avatarKey: null },
  ];

  it("links authors whose account can push, and sends no email", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(accounts as never);
    const res = await app.inject({ method: "GET", url: "/repos/ada/parts/contributors" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.contributors).toEqual([
      { name: "Ada Lovelace", commits: 3, user: { handle: "ada", displayName: "Ada", avatarKey: "k1" } },
      { name: "Bob Builder", commits: 2, user: { handle: "bob", displayName: null, avatarKey: null } },
    ]);
    expect(res.body).not.toContain("@example.com");
  });

  it("lists by name an author whose matching account cannot push", async () => {
    // bob's email now belongs to a READER — someone the owners never trusted to push.
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      accounts[0],
      { id: "eve-1", email: "bob@example.com", handle: "eve", displayName: "Eve", avatarKey: null },
    ] as never);
    const body = (await app.inject({ method: "GET", url: "/repos/ada/parts/contributors" })).json();
    expect(body.contributors[1]).toEqual({ name: "Bob Builder", commits: 2, user: null });
  });

  it("is a 404 on a private repository the caller cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...MOCK_REPO, visibility: "PRIVATE" } as never);
    const anon = await app.inject({ method: "GET", url: "/repos/ada/parts/contributors" });
    expect(anon.statusCode).toBe(404);
    const owner = await app.inject({
      method: "GET",
      url: "/repos/ada/parts/contributors",
      headers: { authorization: await authHeader(app, "owner-1") },
    });
    expect(owner.statusCode).toBe(200);
  });

  it("is empty, not an error, for a ref that does not resolve", async () => {
    const body = (await app.inject({ method: "GET", url: "/repos/ada/parts/contributors?ref=nope" })).json();
    expect(body).toEqual({ ref: "nope", sha: null, total: 0, contributors: [] });
  });
});
