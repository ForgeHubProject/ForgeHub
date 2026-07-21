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
  performSquashMerge,
  performRebaseMerge,
  performRevert,
} from "../git-utils.js";

const AUTHOR = { name: "Merl Merger", email: "merl@forgehub.io" };

async function gitOut(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", workDir, ...args]);
  return stdout.trim();
}

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

// ─── Squash merge ─────────────────────────────────────────────────────────────

describe("performSquashMerge", () => {
  it("collapses the branch into exactly one commit with the merger's author and message", async () => {
    const r = await createTestRepo("squash/basic.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "b.txt": "one" }, "first feature commit");
      await makeCommit(r.workDir, { "c.txt": "two" }, "second feature commit");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const before = Number(await gitOut(r.workDir, ["rev-list", "--count", def]));
      const message = "Add feature (!7)\n\n* first feature commit\n* second feature commit\n";
      const result = await performSquashMerge(r.storageKey, "feature", def, message, AUTHOR);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Exactly one new commit on the base.
      await gitOut(r.workDir, ["fetch", "origin"]);
      const after = Number(await gitOut(r.workDir, ["rev-list", "--count", `origin/${def}`]));
      expect(after).toBe(before + 1);

      // Single parent → no merge commit.
      const parents = (await gitOut(r.workDir, ["rev-list", "--parents", "-n", "1", result.sha])).split(/\s+/);
      expect(parents.length - 1).toBe(1);

      // Authored as the merger, with our subject.
      expect(await gitOut(r.workDir, ["show", "-s", "--format=%an", result.sha])).toBe(AUTHOR.name);
      expect(await gitOut(r.workDir, ["show", "-s", "--format=%ae", result.sha])).toBe(AUTHOR.email);
      expect(await gitOut(r.workDir, ["show", "-s", "--format=%s", result.sha])).toBe("Add feature (!7)");

      // Both changes landed in the single commit.
      expect(await readFileAtBranch(r.storageKey, def, "b.txt")).toBe("one");
      expect(await readFileAtBranch(r.storageKey, def, "c.txt")).toBe("two");
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("returns alreadyMerged when the branch is contained in the base", async () => {
    const r = await createTestRepo("squash/already.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "b.txt": "feat" }, "feat");
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await performMerge(r.storageKey, "feature", def, "merge");

      const result = await performSquashMerge(r.storageKey, "feature", def, "Squash (!1)\n", AUTHOR);
      expect(result.ok).toBe(false);
      if (!result.ok) expect("alreadyMerged" in result).toBe(true);
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});

// ─── Rebase merge ─────────────────────────────────────────────────────────────

describe("performRebaseMerge", () => {
  it("replays commits onto the base (fast-forward, no merge commit) preserving subjects", async () => {
    const r = await createTestRepo("rebase/basic.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "b.txt": "one" }, "feat one");
      await makeCommit(r.workDir, { "c.txt": "two" }, "feat two");
      // Diverge the base so the rebase is a genuine replay, not a plain fast-forward.
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await makeCommit(r.workDir, { "d.txt": "mainwork" }, "main work");

      const result = await performRebaseMerge(r.storageKey, "feature", def);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await gitOut(r.workDir, ["fetch", "origin"]);
      // No merge commits anywhere on the base history.
      expect(await gitOut(r.workDir, ["rev-list", "--merges", `origin/${def}`])).toBe("");
      // Original subjects preserved.
      const subjects = await gitOut(r.workDir, ["log", "--format=%s", `origin/${def}`]);
      expect(subjects).toContain("feat one");
      expect(subjects).toContain("feat two");
      expect(subjects).toContain("main work");
      // Every file present.
      expect(await readFileAtBranch(r.storageKey, def, "b.txt")).toBe("one");
      expect(await readFileAtBranch(r.storageKey, def, "c.txt")).toBe("two");
      expect(await readFileAtBranch(r.storageKey, def, "d.txt")).toBe("mainwork");
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("rejects a conflicting replay with conflicts=true and leaves the base untouched", async () => {
    const r = await createTestRepo("rebase/conflict.git");
    try {
      const def = await (await makeCommit(r.workDir, { "f.txt": "base\n" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "f.txt": "feature\n" }, "feature edit");
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await makeCommit(r.workDir, { "f.txt": "main\n" }, "main edit");

      const beforeSha = await resolveBranchSha(r.storageKey, def);
      const result = await performRebaseMerge(r.storageKey, "feature", def);
      expect(result.ok).toBe(false);
      if (!result.ok) expect("conflicts" in result).toBe(true);

      // Base branch is byte-for-byte unchanged.
      expect(await resolveBranchSha(r.storageKey, def)).toBe(beforeSha);
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});

// ─── Revert ───────────────────────────────────────────────────────────────────

describe("performRevert", () => {
  it("reverts a merge commit (-m 1) producing a branch without the merged changes", async () => {
    const r = await createTestRepo("revert/merge.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "newfile.txt": "hello" }, "add newfile");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const merge = await performMerge(r.storageKey, "feature", def, "Merge feature (#1)");
      expect(merge.ok).toBe(true);
      if (!merge.ok) return;
      expect(await readFileAtBranch(r.storageKey, def, "newfile.txt")).toBe("hello");

      const rev = await performRevert(r.storageKey, def, merge.sha, "revert-pr-1", AUTHOR);
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;
      expect(rev.branch).toBe("revert-pr-1");

      // The reverting branch drops the merged file; the base is untouched.
      expect(await readFileAtBranch(r.storageKey, "revert-pr-1", "newfile.txt")).toBeNull();
      expect(await readFileAtBranch(r.storageKey, def, "newfile.txt")).toBe("hello");
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("reverts a squash (single-parent) commit producing a branch without the change", async () => {
    const r = await createTestRepo("revert/squash.git");
    try {
      const def = await (await makeCommit(r.workDir, { "a.txt": "base" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "newfile2.txt": "world" }, "add newfile2");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const squash = await performSquashMerge(r.storageKey, "feature", def, "Squash (!1)\n", AUTHOR);
      expect(squash.ok).toBe(true);
      if (!squash.ok) return;
      expect(await readFileAtBranch(r.storageKey, def, "newfile2.txt")).toBe("world");

      const rev = await performRevert(r.storageKey, def, squash.sha, "revert-pr-2", AUTHOR);
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;

      expect(await readFileAtBranch(r.storageKey, "revert-pr-2", "newfile2.txt")).toBeNull();
    } finally {
      await r.cleanup();
    }
  }, 30_000);

  it("returns conflicts=true when the revert cannot apply cleanly, leaving the base untouched", async () => {
    const r = await createTestRepo("revert/conflict.git");
    try {
      const def = await (await makeCommit(r.workDir, { "f.txt": "v1\n" }, "base"), defaultBranch(r.storageKey));
      await checkoutBranch(r.workDir, "feature");
      await makeCommit(r.workDir, { "f.txt": "v2\n" }, "to v2");
      await execFile("git", ["-C", r.workDir, "checkout", def]);

      const squash = await performSquashMerge(r.storageKey, "feature", def, "Squash (!1)\n", AUTHOR);
      expect(squash.ok).toBe(true);
      if (!squash.ok) return;

      // Move the base forward again so reverting v1→v2 no longer applies cleanly.
      await execFile("git", ["-C", r.workDir, "fetch", "origin"]);
      await execFile("git", ["-C", r.workDir, "checkout", def]);
      await execFile("git", ["-C", r.workDir, "reset", "--hard", `origin/${def}`]);
      await makeCommit(r.workDir, { "f.txt": "v3\n" }, "to v3");

      const beforeSha = await resolveBranchSha(r.storageKey, def);
      const rev = await performRevert(r.storageKey, def, squash.sha, "revert-pr-3", AUTHOR);
      expect(rev.ok).toBe(false);
      if (!rev.ok) expect("conflicts" in rev).toBe(true);

      // Nothing pushed: base untouched, no revert branch created.
      expect(await resolveBranchSha(r.storageKey, def)).toBe(beforeSha);
      expect(await branchExists(r.storageKey, "revert-pr-3")).toBe(false);
    } finally {
      await r.cleanup();
    }
  }, 30_000);
});
