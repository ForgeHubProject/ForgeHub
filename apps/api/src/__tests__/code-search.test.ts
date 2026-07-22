/**
 * Code search + FHR entity search (issue #111).
 *
 * Pure helpers (query parsing, pathspec building, grep-output parsing, the
 * subprocess timebox) are tested directly; `runCodeGrep` runs against a real
 * seeded bare repo (git is NOT mocked). Route-level tests mock prisma to control
 * repo visibility + entity rows, matching code-nav.test.ts / commits.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";

// ─── Prisma mock (hoisted) ────────────────────────────────────────────────────
vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn(), findMany: vi.fn() },
    entity: { findMany: vi.fn() },
    issue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    protectedBranch: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import {
  parseCodeQuery,
  buildPathspecs,
  parseGrepOutput,
  runWithTimeout,
  runCodeGrep,
} from "../code-search.js";
import { defaultBranch } from "../git-utils.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const NUL = String.fromCharCode(0); // git grep -z field separator / binary-file byte

// ─── parseCodeQuery (pure) ────────────────────────────────────────────────────

describe("parseCodeQuery", () => {
  it("splits free text from repo:/path:/ext: qualifiers", () => {
    const q = parseCodeQuery("landing_gear repo:demo/planes path:src ext:.gltf");
    expect(q.text).toBe("landing_gear");
    expect(q.repo).toEqual({ owner: "demo", name: "planes" });
    expect(q.pathPrefixes).toEqual(["src"]);
    expect(q.exts).toEqual(["gltf"]); // leading dot stripped
  });

  it("keeps the search text when there are no qualifiers", () => {
    const q = parseCodeQuery("export function Button");
    expect(q.text).toBe("export function Button");
    expect(q.repo).toBeUndefined();
    expect(q.pathPrefixes).toEqual([]);
    expect(q.exts).toEqual([]);
  });

  it("supports quoted qualifier values with spaces", () => {
    const q = parseCodeQuery('needle path:"src/deep dir"');
    expect(q.text).toBe("needle");
    expect(q.pathPrefixes).toEqual(["src/deep dir"]);
  });

  it("yields empty text when only qualifiers are given", () => {
    expect(parseCodeQuery("ext:ts").text).toBe("");
  });
});

describe("buildPathspecs", () => {
  it("emits anchored glob for prefixes and **/*.ext for extensions", () => {
    const specs = buildPathspecs(parseCodeQuery("x path:src ext:ts"));
    expect(specs).toContain(":(glob)src**");
    expect(specs).toContain(":(glob)**/*.ts");
  });
});

// ─── parseGrepOutput (pure) ───────────────────────────────────────────────────

describe("parseGrepOutput", () => {
  const rec = (path: string, line: number, text: string) => `main:${path}${NUL}${line}${NUL}${text}`;

  it("groups by file, strips the ref prefix, and keeps line numbers", () => {
    const out = [rec("src/a.ts", 3, "hello"), rec("src/a.ts", 9, "world"), rec("b.txt", 1, "hi")].join("\n") + "\n";
    const r = parseGrepOutput(out, "main", 200, false);
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts", "b.txt"]);
    expect(r.files[0].matches).toEqual([{ line: 3, preview: "hello" }, { line: 9, preview: "world" }]);
    expect(r.totalMatches).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("caps total matches and flags truncation", () => {
    const out = [rec("a", 1, "x"), rec("a", 2, "x"), rec("a", 3, "x")].join("\n") + "\n";
    const r = parseGrepOutput(out, "main", 2, false);
    expect(r.totalMatches).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("passes through the timedOut flag", () => {
    expect(parseGrepOutput("", "main", 200, true).timedOut).toBe(true);
  });
});

// ─── runWithTimeout (the subprocess timebox) ──────────────────────────────────

describe("runWithTimeout", () => {
  it("hard-kills a subprocess that runs past the timeout and returns fast", async () => {
    const start = Date.now();
    const r = await runWithTimeout("sleep", ["5"], tmpdir(), 200);
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2500); // killed early, not after the full 5s
  });

  it("preserves partial stdout captured before the kill", async () => {
    const r = await runWithTimeout("sh", ["-c", "printf 'partial-output'; sleep 5"], tmpdir(), 300);
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain("partial-output");
  });

  it("returns cleanly (not timed out) for a fast command", async () => {
    const r = await runWithTimeout("sh", ["-c", "printf 'done'"], tmpdir(), 2000);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("done");
    expect(r.code).toBe(0);
  });
});

// ─── runCodeGrep on a real multi-file repo ────────────────────────────────────

describe("runCodeGrep", () => {
  let repo: TestRepo;
  let ref: string;

  beforeAll(async () => {
    repo = await createTestRepo("codesearch/repo.git");
    await makeCommit(
      repo.workDir,
      {
        "src/index.ts": 'import { Button } from "./Button";\nexport const x = 1;\n',
        "src/Button.tsx": "export function Button() {\n  return null; // a BUTTON marker\n}\n",
        "docs/guide.md": "# Guide\n\nClick the button to start.\n",
        // Many matches in one file → exercises the cap/truncation.
        "src/many.ts": Array.from({ length: 10 }, (_, i) => `const button${i} = ${i};`).join("\n") + "\n",
        // Binary file containing the needle — must be skipped by -I.
        "assets/blob.bin": `PRE${NUL}button${NUL}POST`,
        ".forge/formats": ".gltf\n",
      },
      "seed",
    );
    ref = await defaultBranch(repo.storageKey);
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); });

  it("is case-insensitive by default (button matches Button/BUTTON)", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "button" });
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/Button.tsx");
    expect(paths).toContain("docs/guide.md");
    // The Button.tsx file matched both "Button" and "BUTTON" case-insensitively.
    const btn = r.files.find((f) => f.path === "src/Button.tsx")!;
    expect(btn.matches.length).toBe(2);
  });

  it("honours case-sensitive mode", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "BUTTON", caseSensitive: true });
    const btn = r.files.find((f) => f.path === "src/Button.tsx");
    expect(btn?.matches).toEqual([{ line: 2, preview: "  return null; // a BUTTON marker" }]);
    // Lowercase-only files must not appear.
    expect(r.files.map((f) => f.path)).not.toContain("docs/guide.md");
  });

  it("skips binary files (-I)", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "button" });
    expect(r.files.map((f) => f.path)).not.toContain("assets/blob.bin");
  });

  it("filters by path: prefix via pathspec", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, {
      pattern: "button",
      pathspecs: buildPathspecs(parseCodeQuery("button path:docs")),
    });
    expect(r.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
  });

  it("filters by ext: via pathspec", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, {
      pattern: "button",
      pathspecs: buildPathspecs(parseCodeQuery("button ext:md")),
    });
    expect(r.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
  });

  it("caps results and reports truncation", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "button", limit: 3 });
    expect(r.totalMatches).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("supports opt-in regex mode", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "button[0-9]", regex: true });
    expect(r.files.map((f) => f.path)).toEqual(["src/many.ts"]);
    expect(r.files[0].matches.length).toBe(10);
  });

  it("returns empty (not an error) when nothing matches", async () => {
    const r = await runCodeGrep(repo.storageKey, ref, { pattern: "zzz-no-such-token" });
    expect(r.files).toEqual([]);
    expect(r.totalMatches).toBe(0);
  });
});

// ─── Route: repo-scoped code search + visibility gating ───────────────────────

describe("GET /repos/:handle/:name/code-search", () => {
  let repo: TestRepo;
  let app: FastifyInstance;
  let ref: string;

  const PRIVATE_REPO = {
    id: "repo-1",
    name: "secret",
    ownerId: "owner-1",
    visibility: "PRIVATE",
    storageKey: "route-codesearch/repo.git",
    collaborators: [] as { userId: string }[],
  };

  beforeAll(async () => {
    repo = await createTestRepo("route-codesearch/repo.git");
    await makeCommit(
      repo.workDir,
      { "src/app.ts": 'const secret = "needle-here";\n', "README.md": "no match here\n" },
      "init",
    );
    ref = await defaultBranch(repo.storageKey);
    app = await createTestServer();
    asMock(prisma.repo.findFirst).mockResolvedValue(PRIVATE_REPO);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await repo.cleanup();
  });

  it("excludes a private repo from a non-reader (404)", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/owner/secret/code-search?q=needle" });
    expect(res.statusCode).toBe(404);
  });

  it("returns grouped grep results (with permalink sha) to the owner", async () => {
    const token = await app.jwt.sign({ sub: "owner-1" });
    const res = await app.inject({
      method: "GET",
      url: "/repos/owner/secret/code-search?q=needle",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(["src/app.ts"]);
    expect(body.files[0].matches[0]).toMatchObject({ line: 1 });
    expect(body.truncated).toBe(false);
    expect(body.timedOut).toBe(false);
  });

  it("400s on a too-short query", async () => {
    const token = await app.jwt.sign({ sub: "owner-1" });
    const res = await app.inject({
      method: "GET",
      url: "/repos/owner/secret/code-search?q=a",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Route: FHR entity search (mocked prisma) ─────────────────────────────────

describe("GET /search?type=entities", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestServer();
  });
  afterAll(async () => { await app.close(); });

  const ENTITY_ROW = {
    id: "ent-1",
    name: "landing_gear",
    kind: "node",
    path: "Plane/landing_gear",
    snapshot: {
      id: "snap-1",
      sourceFile: "models/plane.gltf",
      label: "Add landing gear",
      handlerId: "gltf-scene",
      gitCommitSha: "a".repeat(40),
      repo: { name: "planes", owner: { handle: "demo" } },
    },
  };

  it("returns entity rows with name/kind/source and repo, and scopes by visibility", async () => {
    asMock(prisma.entity.findMany).mockResolvedValue([ENTITY_ROW]);
    const res = await app.inject({ method: "GET", url: "/search?type=entities&q=landing_gear" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("entities");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: "ent-1",
      name: "landing_gear",
      kind: "node",
      repo: { ownerHandle: "demo", name: "planes" },
      snapshot: { sourceFile: "models/plane.gltf", gitCommitSha: "a".repeat(40) },
    });

    // The Entity query must be visibility-scoped through snapshot.repo.
    const where = asMock(prisma.entity.findMany).mock.calls[0][0].where;
    const scoped = where.AND.find((c: Record<string, unknown>) => "snapshot" in c);
    expect(scoped).toBeTruthy();
    const repoScope = scoped.snapshot.repo;
    expect(JSON.stringify(repoScope)).toContain("PUBLIC");
  });

  it("scopes to owner + collaborators for an authenticated viewer", async () => {
    asMock(prisma.entity.findMany).mockResolvedValue([]);
    const token = await app.jwt.sign({ sub: "user-9" });
    const res = await app.inject({
      method: "GET",
      url: "/search?type=entities&q=gear",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
    const where = asMock(prisma.entity.findMany).mock.calls.at(-1)![0].where;
    const scoped = where.AND.find((c: Record<string, unknown>) => "snapshot" in c);
    expect(JSON.stringify(scoped.snapshot.repo)).toContain("user-9");
  });

  it("honours a repo: qualifier by narrowing the snapshot.repo scope", async () => {
    asMock(prisma.entity.findMany).mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/search?type=entities&q=gear repo:demo/planes" });
    expect(res.statusCode).toBe(200);
    const where = asMock(prisma.entity.findMany).mock.calls.at(-1)![0].where;
    const scoped = where.AND.find((c: Record<string, unknown>) => "snapshot" in c);
    expect(JSON.stringify(scoped.snapshot.repo)).toContain("planes");
  });
});

// ─── Route: global code search (mocked repo list, real grep) ──────────────────

describe("GET /search?type=code", () => {
  let repo: TestRepo;
  let app: FastifyInstance;

  beforeAll(async () => {
    repo = await createTestRepo("global-codesearch/repo.git");
    await makeCommit(repo.workDir, { "lib/util.ts": "export const marker = 42;\n" }, "init");
    app = await createTestServer();
    asMock(prisma.repo.findMany).mockResolvedValue([
      { id: "r1", name: "toolbox", owner: { handle: "demo" }, storageKey: "global-codesearch/repo.git" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await repo.cleanup();
  });

  it("aggregates grep hits across readable repos into per-file rows", async () => {
    const res = await app.inject({ method: "GET", url: "/search?type=code&q=marker" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("code");
    expect(body.reposSearched).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      repo: { ownerHandle: "demo", name: "toolbox" },
      path: "lib/util.ts",
    });
    expect(body.results[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns empty results when the query is only qualifiers", async () => {
    const res = await app.inject({ method: "GET", url: "/search?type=code&q=ext:ts" });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
  });
});
