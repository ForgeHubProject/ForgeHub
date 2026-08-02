import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import {
  CODEOWNERS_PATHS,
  compilePattern,
  loadCodeowners,
  ownersForPath,
  ownersForPaths,
  parseCodeowners,
} from "../codeowners.js";

// ─── Pattern grammar ──────────────────────────────────────────────────────────

describe("compilePattern", () => {
  const cases: Array<{ pattern: string; matches: string[]; misses: string[] }> = [
    // Bare name — unanchored, matches at any depth, and owns the subtree.
    { pattern: "docs", matches: ["docs", "docs/a.md", "apps/docs/b.md"], misses: ["docsy", "a/docsx/y"] },
    // Anchored by a leading slash.
    { pattern: "/docs", matches: ["docs/a.md"], misses: ["apps/docs/a.md"] },
    // Directory-only: the contents, not the entry itself.
    { pattern: "docs/", matches: ["docs/a.md", "apps/docs/b.md"], misses: ["docs"] },
    // `*` stays inside one segment.
    // (a directory literally named `a.ts` would own its contents too — gitignore's rule)
    { pattern: "*.ts", matches: ["a.ts", "apps/api/src/b.ts"], misses: ["a.tsx", "a.ts.bak"] },
    { pattern: "apps/*/package.json", matches: ["apps/api/package.json"], misses: ["apps/api/src/package.json"] },
    // `**` spans segments, and `a/**/b` also matches zero segments.
    { pattern: "apps/**/*.ts", matches: ["apps/a.ts", "apps/api/src/b.ts"], misses: ["web/a.ts"] },
    { pattern: "**/schema.prisma", matches: ["schema.prisma", "apps/api/prisma/schema.prisma"], misses: ["schema.prisma.bak"] },
    // Single-char wildcard and character classes.
    { pattern: "v?.txt", matches: ["v1.txt", "docs/v2.txt"], misses: ["v10.txt"] },
    { pattern: "log[0-9].txt", matches: ["log4.txt"], misses: ["loga.txt"] },
    // An interior slash anchors even without a leading one.
    { pattern: "apps/web/", matches: ["apps/web/src/App.tsx"], misses: ["x/apps/web/src/App.tsx"] },
    // Dots are literal, not regex wildcards.
    { pattern: "a.ts", matches: ["a.ts"], misses: ["axts"] },
  ];

  for (const { pattern, matches, misses } of cases) {
    it(`'${pattern}' matches ${matches.length} / rejects ${misses.length}`, () => {
      const re = compilePattern(pattern);
      expect(re).not.toBeNull();
      for (const path of matches) expect(re!.test(path), `${pattern} should match ${path}`).toBe(true);
      for (const path of misses) expect(re!.test(path), `${pattern} should not match ${path}`).toBe(false);
    });
  }

  it("returns null for a pattern with nothing to match", () => {
    expect(compilePattern("/")).toBeNull();
    expect(compilePattern("")).toBeNull();
  });
});

// ─── File parsing ─────────────────────────────────────────────────────────────

describe("parseCodeowners", () => {
  it("keeps pattern + @handles, ignoring comments and blank lines", () => {
    const rules = parseCodeowners([
      "# owners of everything",
      "",
      "*   @Alice  @bob",
      "   ",
      "docs/ @carol # docs crew",
    ].join("\n"));

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ line: 3, pattern: "*", owners: ["alice", "bob"], negated: false });
    expect(rules[1]).toMatchObject({ line: 5, pattern: "docs/", owners: ["carol"] });
  });

  it("drops owner tokens that aren't @handles and de-dupes the rest", () => {
    const rules = parseCodeowners("* @alice alice@example.com @org/team @alice");
    expect(rules[0]!.owners).toEqual(["alice"]);
  });

  it("records a negated rule with no owners", () => {
    const rules = parseCodeowners("!apps/api/generated/ @alice");
    expect(rules[0]).toMatchObject({ pattern: "apps/api/generated/", negated: true, owners: [] });
  });

  it("skips unusable lines instead of throwing", () => {
    const rules = parseCodeowners(["/", "* @alice", "# nothing", "  "].join("\n"));
    expect(rules.map((r) => r.pattern)).toEqual(["*"]);
  });

  it("tolerates CRLF line endings", () => {
    const rules = parseCodeowners("* @alice\r\ndocs/ @bob\r\n");
    expect(rules.map((r) => r.owners)).toEqual([["alice"], ["bob"]]);
  });
});

// ─── Matching ─────────────────────────────────────────────────────────────────

describe("ownersForPath", () => {
  const file = [
    "* @default-owner",
    "apps/api/ @api-team",
    "apps/api/prisma/ @db-team",
    "!apps/api/prisma/generated/",
    "docs/ @docs-team",
    "docs/legal/ ",
  ].join("\n");
  const rules = parseCodeowners(file);

  const cases: Array<[string, string[]]> = [
    ["README.md", ["default-owner"]],
    ["apps/api/src/server.ts", ["api-team"]],
    // Last match wins — the more specific rule sits lower in the file.
    ["apps/api/prisma/schema.prisma", ["db-team"]],
    // …and a negated rule below it wins in turn, leaving the path unowned.
    ["apps/api/prisma/generated/client.ts", []],
    ["docs/guide.md", ["docs-team"]],
    // A rule with a pattern but no owners clears ownership just like a negation.
    ["docs/legal/terms.md", []],
  ];

  for (const [path, expected] of cases) {
    it(`${path} → ${expected.length ? expected.join(", ") : "(unowned)"}`, () => {
      expect(ownersForPath(rules, path)).toEqual(expected);
    });
  }

  it("normalizes leading ./ and / on the queried path", () => {
    expect(ownersForPath(rules, "./apps/api/src/a.ts")).toEqual(["api-team"]);
    expect(ownersForPath(rules, "/apps/api/src/a.ts")).toEqual(["api-team"]);
  });

  it("is empty when no rule matches", () => {
    expect(ownersForPath(parseCodeowners("docs/ @docs-team"), "src/a.ts")).toEqual([]);
  });
});

describe("ownersForPaths", () => {
  const rules = parseCodeowners(["* @root", "apps/api/ @api", "apps/web/ @web"].join("\n"));

  it("unions owners across the changed files, first-seen order, de-duped", () => {
    expect(ownersForPaths(rules, ["apps/web/a.tsx", "apps/api/b.ts", "apps/api/c.ts", "README.md"]))
      .toEqual(["web", "api", "root"]);
  });

  it("is empty for no rules or no files", () => {
    expect(ownersForPaths([], ["a.ts"])).toEqual([]);
    expect(ownersForPaths(rules, [])).toEqual([]);
  });
});

// ─── Loading from a repo ──────────────────────────────────────────────────────

describe("loadCodeowners", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("test/codeowners.git");
    await makeCommit(repo.workDir, { "readme.txt": "hi" }, "init");
  });
  afterAll(async () => { await repo.cleanup(); });

  // The conventional locations are checked in order, so the assertions below run
  // against one repo that grows a higher-precedence copy at each step.
  it("returns no rules when the repo has no CODEOWNERS", async () => {
    expect(await loadCodeowners(repo.storageKey, "HEAD")).toEqual([]);
  });

  it("reads docs/CODEOWNERS when it is the only copy", async () => {
    await makeCommit(repo.workDir, { "docs/CODEOWNERS": "* @docs-owner\n" }, "docs codeowners");
    expect(ownersForPath(await loadCodeowners(repo.storageKey, "HEAD"), "a.ts")).toEqual(["docs-owner"]);
  });

  it("prefers the repo-root copy over docs/", async () => {
    await makeCommit(repo.workDir, { "CODEOWNERS": "* @root-owner\n" }, "root codeowners");
    expect(ownersForPath(await loadCodeowners(repo.storageKey, "HEAD"), "a.ts")).toEqual(["root-owner"]);
  });

  it("prefers .forgehub/CODEOWNERS over everything else", async () => {
    await makeCommit(repo.workDir, { ".forgehub/CODEOWNERS": "* @forgehub-owner\n" }, "forgehub codeowners");
    expect(ownersForPath(await loadCodeowners(repo.storageKey, "HEAD"), "a.ts")).toEqual(["forgehub-owner"]);
    expect(CODEOWNERS_PATHS[0]).toBe(".forgehub/CODEOWNERS");
  });
});
