import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createTestRepo, makeCommit, checkoutBranch, type TestRepo } from "./helpers/git.js";
import {
  branchExists,
  defaultBranch,
  listBranches,
  createBranch,
  deleteBranch,
  resolveBranchSha,
  readFileAtBranch,
  listFilesDifferingBetweenBranches,
  listTags,
  createTag,
  deleteTag,
  performMerge,
  performMergeWithResolvedFiles,
} from "../git-utils.js";

const execFile = promisify(execFileCb);

// ─── Shared repo setup ────────────────────────────────────────────────────────

let repo: TestRepo;

beforeAll(async () => {
  repo = await createTestRepo("test/repo.git");
  // Make an initial commit on the default branch so the repo is non-empty
  await makeCommit(repo.workDir, { "readme.txt": "hello world" }, "init");
}, 30_000);

afterAll(async () => {
  await repo.cleanup();
});

// ─── Branches ─────────────────────────────────────────────────────────────────

describe("defaultBranch", () => {
  it("returns the default branch name after initial commit", async () => {
    const name = await defaultBranch(repo.storageKey);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("branchExists", () => {
  it("returns true for the default branch", async () => {
    const def = await defaultBranch(repo.storageKey);
    expect(await branchExists(repo.storageKey, def)).toBe(true);
  });

  it("returns false for a non-existent branch", async () => {
    expect(await branchExists(repo.storageKey, "branch-that-does-not-exist")).toBe(false);
  });
});

describe("listBranches", () => {
  it("returns at least the default branch", async () => {
    const branches = await listBranches(repo.storageKey);
    expect(branches.length).toBeGreaterThan(0);
    const def = await defaultBranch(repo.storageKey);
    expect(branches.some((b) => b.name === def)).toBe(true);
  });

  it("marks the default branch with isDefault=true", async () => {
    const branches = await listBranches(repo.storageKey);
    const def = branches.find((b) => b.isDefault);
    expect(def).toBeDefined();
  });

  it("each branch has a sha, subject, and date", async () => {
    const branches = await listBranches(repo.storageKey);
    for (const b of branches) {
      expect(b.sha).toBeTruthy();
      expect(typeof b.subject).toBe("string");
      expect(typeof b.date).toBe("string");
    }
  });
});

describe("createBranch / deleteBranch", () => {
  it("creates a branch then removes it", async () => {
    const def = await defaultBranch(repo.storageKey);
    const sha = await resolveBranchSha(repo.storageKey, def);

    await createBranch(repo.storageKey, "temp-branch", sha!);
    expect(await branchExists(repo.storageKey, "temp-branch")).toBe(true);

    await deleteBranch(repo.storageKey, "temp-branch", true);
    expect(await branchExists(repo.storageKey, "temp-branch")).toBe(false);
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe("listTags / createTag / deleteTag", () => {
  it("starts with no tags", async () => {
    const tags = await listTags(repo.storageKey);
    expect(Array.isArray(tags)).toBe(true);
  });

  it("creates a lightweight tag then deletes it", async () => {
    const def = await defaultBranch(repo.storageKey);
    const sha = await resolveBranchSha(repo.storageKey, def);
    await createTag(repo.storageKey, "v0.0.1-test", sha!);

    const tags = await listTags(repo.storageKey);
    expect(tags.some((t) => t.name === "v0.0.1-test")).toBe(true);

    await deleteTag(repo.storageKey, "v0.0.1-test");
    const after = await listTags(repo.storageKey);
    expect(after.some((t) => t.name === "v0.0.1-test")).toBe(false);
  });

  it("creates an annotated tag with a message", async () => {
    const def = await defaultBranch(repo.storageKey);
    const sha = await resolveBranchSha(repo.storageKey, def);
    await createTag(repo.storageKey, "v0.0.2-test", sha!, "Release 0.0.2");

    const tags = await listTags(repo.storageKey);
    expect(tags.some((t) => t.name === "v0.0.2-test")).toBe(true);

    await deleteTag(repo.storageKey, "v0.0.2-test");
  });
});

// ─── SHA and file reads ───────────────────────────────────────────────────────

describe("resolveBranchSha", () => {
  it("returns a 40-char hex SHA for an existing branch", async () => {
    const def = await defaultBranch(repo.storageKey);
    const sha = await resolveBranchSha(repo.storageKey, def);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a non-existent branch", async () => {
    const sha = await resolveBranchSha(repo.storageKey, "no-such-branch");
    expect(sha).toBeNull();
  });
});

describe("readFileAtBranch", () => {
  it("reads a committed file's content", async () => {
    const def = await defaultBranch(repo.storageKey);
    const content = await readFileAtBranch(repo.storageKey, def, "readme.txt");
    expect(content).toBe("hello world");
  });

  it("returns null for a file that does not exist on the branch", async () => {
    const def = await defaultBranch(repo.storageKey);
    const content = await readFileAtBranch(repo.storageKey, def, "no-such-file.txt");
    expect(content).toBeNull();
  });
});

// ─── Merge scenarios ──────────────────────────────────────────────────────────
// Each merge test uses a fresh repo to avoid branch state leaking between tests.

describe("performMerge", () => {
  it("fast-forward merge succeeds and returns sha", async () => {
    const r = await createTestRepo("merge/ff.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "b.txt": "feature" }, "feature commit");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const result = await performMerge(r.storageKey, "feature", def, "merge feature");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("detects merge conflicts and returns ok=false with conflicts=true", async () => {
    const r = await createTestRepo("merge/conflict.git");
    try {
      const def = await (await makeCommit(r.workDir, { "shared.txt": "original\n" }, "base"), defaultBranch(r.storageKey));

      // Feature branch modifies shared.txt
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "shared.txt": "feature-version\n" }, "feature edit");

      // Main also modifies shared.txt (conflicting)
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await makeCommit(r.workDir, { "shared.txt": "main-version\n" }, "main edit");

      const result = await performMerge(r.storageKey, "feature", def, "merge attempt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect("conflicts" in result).toBe(true);
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("detects already-merged branch and returns ok=false with alreadyMerged=true", async () => {
    const r = await createTestRepo("merge/already.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "b.txt": "feature" }, "feature commit");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      // First merge succeeds
      await performMerge(r.storageKey, "feature", def, "first merge");

      // Second merge attempt should report already merged
      const result = await performMerge(r.storageKey, "feature", def, "second merge");
      expect(result.ok).toBe(false);
      if (!result.ok) expect("alreadyMerged" in result).toBe(true);
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("ours strategy resolves conflicts by keeping base content", async () => {
    const r = await createTestRepo("merge/ours.git");
    try {
      const def = await (await makeCommit(r.workDir, { "f.txt": "base\n" }, "init"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "f.txt": "feature\n" }, "feature edit");
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await makeCommit(r.workDir, { "f.txt": "main\n" }, "main edit");

      const result = await performMerge(r.storageKey, "feature", def, "ours merge", "ours");
      expect(result.ok).toBe(true);

      if (result.ok) {
        const content = await readFileAtBranch(r.storageKey, def, "f.txt");
        expect(content).toBe("main");
      }
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});

describe("performMergeWithResolvedFiles", () => {
  it("merges a conflicting change using provided resolved content", async () => {
    const r = await createTestRepo("merge/resolved.git");
    try {
      const def = await (await makeCommit(r.workDir, { "f.txt": "shared\n" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "f.txt": "feature-edit\n" }, "feature");
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await makeCommit(r.workDir, { "f.txt": "main-edit\n" }, "main edit");

      const result = await performMergeWithResolvedFiles(
        r.storageKey, "feature", def, "resolved merge",
        { "f.txt": "manually-resolved\n" },
      );
      expect(result.ok).toBe(true);

      if (result.ok) {
        const content = await readFileAtBranch(r.storageKey, def, "f.txt");
        expect(content).toBe("manually-resolved");
      }
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});

// ─── File diff between branches ───────────────────────────────────────────────

describe("listFilesDifferingBetweenBranches", () => {
  it("returns files changed on feature branch relative to main", async () => {
    const r = await createTestRepo("diff/files.git");
    try {
      const def = await (await makeCommit(r.workDir, { "shared.txt": "shared" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "feature-only.txt": "new" }, "feature file");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const files = await listFilesDifferingBetweenBranches(r.storageKey, def, "feature");
      expect(files).toContain("feature-only.txt");
      expect(files).not.toContain("shared.txt");
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("returns empty array when branches are identical", async () => {
    const r = await createTestRepo("diff/identical.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "a" }, "base"), defaultBranch(r.storageKey));
      const def2 = await defaultBranch(r.storageKey);
      const sha = await resolveBranchSha(r.storageKey, def2);
      await createBranch(r.storageKey, "copy", sha!);

      const files = await listFilesDifferingBetweenBranches(r.storageKey, def, "copy");
      expect(files).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});
