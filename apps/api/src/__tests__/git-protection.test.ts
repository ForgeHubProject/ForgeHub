import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { writeProtectionConfig, PROTECTION_CONFIG_BASENAME } from "../git-hooks.js";

const execFile = promisify(execFileCb);

/**
 * End-to-end enforcement of the branch-protection pre-receive hook (issue #85)
 * via REAL local git pushes against a bare repo. `createTestRepo` installs the
 * hook (through `createBareRepo`); we drive rules by writing the config file the
 * hook reads, then push and assert on the rejection.
 */

/** Push HEAD of `workDir` to `branch`; resolve {ok, stderr}. */
async function tryPush(workDir: string, refspec: string, opts: { force?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const args = ["-C", workDir, "push", ...(opts.force ? ["--force"] : []), "origin", refspec];
  try {
    const { stderr } = await execFile("git", args, { env: { ...process.env, ...opts.env } });
    return { ok: true, stderr };
  } catch (err) {
    return { ok: false, stderr: (err as { stderr?: string }).stderr ?? String(err) };
  }
}

describe("branch-protection pre-receive hook (real git)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo("prot/repo.git");
    // Seed `main` with an initial commit (no rules yet → allowed).
    await makeCommit(repo.workDir, { "README.md": "# hi\n" }, "init", "main");
  });
  afterEach(async () => { await repo.cleanup(); });

  it("installs an executable pre-receive hook on repo creation", async () => {
    const hookPath = join(repo.bareRepoPath, "hooks", "pre-receive");
    const st = await stat(hookPath);
    expect(st.isFile()).toBe(true);
    // Owner-executable bit set.
    expect(st.mode & 0o100).toBe(0o100);
    const body = await readFile(hookPath, "utf8");
    expect(body).toContain("FORGEHUB_INTERNAL_PUSH");
  });

  it("allows pushes when no branch is protected", async () => {
    const res = await makeCommitPush(repo, { "a.txt": "1\n" }, "no rules");
    expect(res.ok).toBe(true);
  });

  it("rejects a direct push to a requirePullRequest branch with a clear message", async () => {
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "main", requirePullRequest: true, blockForcePush: false },
    ]);
    // New commit on main, then push.
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "direct"]);
    const res = await tryPush(repo.workDir, "main");
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/direct pushes are blocked/i);
    expect(res.stderr).toMatch(/pull request/i);
  });

  it("lets FORGEHUB_INTERNAL_PUSH=1 bypass the hook (sanctioned merge path)", async () => {
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "main", requirePullRequest: true, blockForcePush: false },
    ]);
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "internal"]);
    const res = await tryPush(repo.workDir, "main", { env: { FORGEHUB_INTERNAL_PUSH: "1" } });
    expect(res.ok).toBe(true);
  });

  it("allows a fast-forward push but rejects a force (non-fast-forward) push when blockForcePush is set", async () => {
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "main", requirePullRequest: false, blockForcePush: true },
    ]);

    // Fast-forward: a normal new commit is allowed.
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "ff commit"]);
    const ff = await tryPush(repo.workDir, "main");
    expect(ff.ok).toBe(true);

    // Rewrite history (amend) → non-fast-forward → force push rejected.
    await execFile("git", ["-C", repo.workDir, "commit", "--amend", "--allow-empty", "-m", "rewritten"]);
    const forced = await tryPush(repo.workDir, "main", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.stderr).toMatch(/non-fast-forward|force/i);
  });

  it("does not affect force pushes to an unprotected branch", async () => {
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "main", requirePullRequest: false, blockForcePush: true },
    ]);
    // Create + push a feature branch (unprotected).
    await execFile("git", ["-C", repo.workDir, "checkout", "-b", "feature"]);
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "f1"]);
    expect((await tryPush(repo.workDir, "feature")).ok).toBe(true);
    // Rewrite + force push the feature branch → allowed (not protected).
    await execFile("git", ["-C", repo.workDir, "commit", "--amend", "--allow-empty", "-m", "f1 rewritten"]);
    expect((await tryPush(repo.workDir, "feature", { force: true })).ok).toBe(true);
  });

  it("blocks deletion of a protected branch even with no push flags", async () => {
    // Push a second branch to delete.
    await execFile("git", ["-C", repo.workDir, "checkout", "-b", "release"]);
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "r1"]);
    await tryPush(repo.workDir, "release");
    // Protect `release` with no flags — deletion must still be refused.
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "release", requirePullRequest: false, blockForcePush: false },
    ]);
    const del = await tryPush(repo.workDir, ":release");
    expect(del.ok).toBe(false);
    expect(del.stderr).toMatch(/cannot be deleted/i);
  });

  it("removes the rules file when protection is cleared (config round-trips)", async () => {
    await writeProtectionConfig(repo.bareRepoPath, [
      { branch: "main", requirePullRequest: true, blockForcePush: true },
    ]);
    const confPath = join(repo.bareRepoPath, PROTECTION_CONFIG_BASENAME);
    expect(await readFile(confPath, "utf8")).toContain("main pr,force");
    await writeProtectionConfig(repo.bareRepoPath, []);
    await expect(stat(confPath)).rejects.toBeTruthy();
  });
});

/** Commit files and push HEAD, returning the push result. */
async function makeCommitPush(repo: TestRepo, files: Record<string, string>, message: string) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repo.workDir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await execFile("git", ["-C", repo.workDir, "add", "-A"]);
  await execFile("git", ["-C", repo.workDir, "commit", "-m", message]);
  return tryPush(repo.workDir, "HEAD");
}
