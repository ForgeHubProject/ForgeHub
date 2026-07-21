/**
 * Code-navigation tests — blame parsing, ahead/behind, ref compare, and the
 * streaming archive endpoint. Uses real bare git repos (git-utils is NOT mocked);
 * prisma is mocked to control repo visibility + auth, matching commits.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

// ─── Prisma mock (hoisted) ────────────────────────────────────────────────────
vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import {
  parseBlamePorcelain,
  getBlame,
  countAheadBehind,
  compareRefs,
  resolveRefSha,
  defaultBranch,
} from "../git-utils.js";
import { createTestRepo, makeCommit, checkoutBranch, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

const execFile = promisify(execFileCb);

// ─── parseBlamePorcelain (pure) ───────────────────────────────────────────────

describe("parseBlamePorcelain", () => {
  it("coalesces consecutive same-commit lines and splits at a different commit", () => {
    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    const raw = [
      `${sha1} 1 1 2`,
      "author Alice",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "summary initial",
      "filename a.txt",
      "\tline1",
      `${sha1} 2 2`,
      "\tline2",
      `${sha2} 3 3 1`,
      "author Bob",
      "author-mail <bob@example.com>",
      "author-time 1700000500",
      "author-tz +0000",
      "summary second",
      "filename a.txt",
      "\tline3",
    ].join("\n");

    const hunks = parseBlamePorcelain(raw);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ sha: sha1, author: "Alice", authorMail: "alice@example.com", startLine: 1, endLine: 2 });
    expect(hunks[0].lines).toEqual(["line1", "line2"]);
    expect(hunks[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hunks[1]).toMatchObject({ sha: sha2, author: "Bob", startLine: 3, endLine: 3 });
    expect(hunks[1].lines).toEqual(["line3"]);
  });
});

// ─── Real-repo blame / compare / ahead-behind ─────────────────────────────────

describe("getBlame on a real multi-commit repo", () => {
  let repo: TestRepo;
  let c1: string;
  let c2: string;

  beforeAll(async () => {
    repo = await createTestRepo("blame/repo.git");
    c1 = await makeCommit(repo.workDir, { "a.txt": "line1\nline2\nline3\n" }, "init");
    c2 = await makeCommit(repo.workDir, { "a.txt": "line1\nCHANGED\nline3\n" }, "change middle");
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); });

  it("attributes each line to the commit that last touched it", async () => {
    const def = await defaultBranch(repo.storageKey);
    const hunks = await getBlame(repo.storageKey, def, "a.txt");
    // line1 → c1, line2 → c2, line3 → c1  ⇒ three hunks
    expect(hunks).toHaveLength(3);
    expect(hunks.map((h) => `${h.startLine}-${h.endLine}`)).toEqual(["1-1", "2-2", "3-3"]);
    expect(hunks[0].sha).toBe(c1);
    expect(hunks[1].sha).toBe(c2);
    expect(hunks[1].lines).toEqual(["CHANGED"]);
    expect(hunks[2].sha).toBe(c1);
    for (const h of hunks) {
      expect(h.author).toBe("ForgeHub Test");
      expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(h.shortSha).toBe(h.sha.slice(0, 7));
    }
  });

  it("returns [] for a missing file", async () => {
    const def = await defaultBranch(repo.storageKey);
    expect(await getBlame(repo.storageKey, def, "nope.txt")).toEqual([]);
  });
});

describe("countAheadBehind + compareRefs", () => {
  let repo: TestRepo;
  let def: string;

  beforeAll(async () => {
    repo = await createTestRepo("compare/repo.git");
    await makeCommit(repo.workDir, { "a.txt": "base\n" }, "base");
    def = await defaultBranch(repo.storageKey);
    // feature branches off, adds a file and edits a.txt
    await checkoutBranch(repo.workDir, "feature");
    await makeCommit(repo.workDir, { "feature.txt": "new\n", "a.txt": "changed\n" }, "feature work");
    // main advances by one commit → feature is 1 behind, 1 ahead
    await execFile("git", ["-C", repo.workDir, "checkout", def]);
    await makeCommit(repo.workDir, { "b.txt": "on-main\n" }, "advance main");
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); });

  it("computes ahead/behind of feature vs default", async () => {
    const { ahead, behind } = await countAheadBehind(repo.storageKey, def, "feature");
    expect(ahead).toBe(1);
    expect(behind).toBe(1);
  });

  it("compareRefs lists only head-introduced commits + changed files (merge-base)", async () => {
    const cmp = await compareRefs(repo.storageKey, def, "feature");
    expect(cmp).not.toBeNull();
    expect(cmp!.ahead).toBe(1);
    expect(cmp!.behind).toBe(1);
    expect(cmp!.commits).toHaveLength(1);
    expect(cmp!.commits[0].subject).toBe("feature work");
    const paths = cmp!.files.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", "feature.txt"]);
    const added = cmp!.files.find((f) => f.path === "feature.txt");
    expect(added?.status).toBe("added");
    // b.txt landed on main only — it must NOT appear in the head-introduced set
    expect(paths).not.toContain("b.txt");
  });

  it("compareRefs returns null when a ref is unknown", async () => {
    expect(await compareRefs(repo.storageKey, def, "no-such-branch")).toBeNull();
  });
});

// ─── Route-level: archive + ref-compare + branches ahead/behind ────────────────

describe("code-nav routes", () => {
  let repo: TestRepo;
  let app: FastifyInstance;
  let def: string;

  const MOCK_REPO = {
    id: "repo-1",
    name: "my-repo",
    ownerId: "user-1",
    visibility: "PUBLIC",
    storageKey: "route/repo.git",
    collaborators: [] as unknown[],
  };

  beforeAll(async () => {
    repo = await createTestRepo("route/repo.git");
    await makeCommit(repo.workDir, { "readme.txt": "hello archive\n", "a.txt": "base\n" }, "init");
    def = await defaultBranch(repo.storageKey);
    await checkoutBranch(repo.workDir, "feature");
    await makeCommit(repo.workDir, { "feature.txt": "new\n" }, "feature work");
    await execFile("git", ["-C", repo.workDir, "checkout", def]);

    app = await createTestServer();
    (prisma.repo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_REPO);
    (prisma.protectedBranch.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await repo.cleanup();
  });

  it("archive streams a valid zip (PK magic + prefixed entry name)", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/archive?ref=${def}&format=zip` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(String(res.headers["content-disposition"])).toContain(".zip");
    const buf = res.rawPayload;
    // ZIP local file header magic: 0x50 0x4B 0x03 0x04 ("PK\x03\x04")
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // git archive --prefix embeds the entry paths as plain text in the stream
    expect(buf.toString("latin1")).toContain("my-repo-");
    expect(buf.toString("latin1")).toContain("readme.txt");
  });

  it("archive 404s on an unknown ref", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/archive?ref=no-such-ref" });
    expect(res.statusCode).toBe(404);
  });

  it("resolve-ref returns the canonical 40-char SHA", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/resolve-ref?ref=${def}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ref-compare reports ahead/behind + files", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/ref-compare?base=${def}&head=feature` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(0);
    expect(body.commits).toHaveLength(1);
    expect(body.files.map((f: { path: string }) => f.path)).toContain("feature.txt");
  });

  it("ref-compare/diff returns full hunks for changed files", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/ref-compare/diff?base=${def}&head=feature` });
    expect(res.statusCode).toBe(200);
    const files = res.json().files as Array<{ newPath: string; hunks: unknown[] }>;
    const added = files.find((f) => f.newPath === "feature.txt");
    expect(added).toBeTruthy();
    expect(added!.hunks.length).toBeGreaterThan(0);
  });

  it("branches route annotates ahead/behind vs default", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/branches" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const feature = body.branches.find((b: { name: string }) => b.name === "feature");
    const main = body.branches.find((b: { name: string }) => b.name === def);
    expect(feature.ahead).toBe(1);
    expect(feature.behind).toBe(0);
    expect(main.ahead).toBe(0);
    expect(main.behind).toBe(0);
  });

  it("blame route returns hunks for a tracked file", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/alice/my-repo/blame?ref=${def}&path=readme.txt` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hunks.length).toBeGreaterThan(0);
    expect(body.hunks[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
