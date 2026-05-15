import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { bareRepoPathFromKey } from "../../git-storage.js";

const execFile = promisify(execFileCb);

export type TestRepo = {
  storageRoot: string;
  storageKey: string;
  bareRepoPath: string;
  workDir: string;
  /** Clean up all temp directories. */
  cleanup: () => Promise<void>;
};

/**
 * Create a temp bare repo + cloned work dir with git identity configured.
 * Caller must call cleanup() in afterEach/afterAll.
 */
export async function createTestRepo(key = "test/repo.git"): Promise<TestRepo> {
  const storageRoot = await mkdtemp(join(tmpdir(), "fh-git-test-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;

  const { createBareRepo } = await import("../../git-storage.js");
  const bareRepoPath = await createBareRepo(key);

  const workDir = await mkdtemp(join(tmpdir(), "fh-work-"));
  await execFile("git", ["clone", bareRepoPath, workDir]);
  await execFile("git", ["-C", workDir, "config", "user.email", "test@forgehub.io"]);
  await execFile("git", ["-C", workDir, "config", "user.name", "ForgeHub Test"]);
  await execFile("git", ["-C", workDir, "config", "commit.gpgsign", "false"]);
  await execFile("git", ["-C", workDir, "config", "tag.gpgsign", "false"]);

  return {
    storageRoot,
    storageKey: key,
    bareRepoPath,
    workDir,
    cleanup: async () => {
      delete process.env["GIT_STORAGE_ROOT"];
      await rm(storageRoot, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/**
 * Write files to workDir, stage, commit, and push to origin.
 * Returns the commit SHA.
 */
export async function makeCommit(
  workDir: string,
  files: Record<string, string>,
  message: string,
  branch?: string,
): Promise<string> {
  if (branch) {
    try {
      await execFile("git", ["-C", workDir, "checkout", branch]);
    } catch {
      await execFile("git", ["-C", workDir, "checkout", "-b", branch]);
    }
  }
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(workDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await execFile("git", ["-C", workDir, "add", "-A"]);
  await execFile("git", ["-C", workDir, "commit", "-m", message]);
  await execFile("git", ["-C", workDir, "push", "origin", "HEAD"]);
  const { stdout } = await execFile("git", ["-C", workDir, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/** Push current branch to origin without additional commits. */
export async function pushBranch(workDir: string, branch: string): Promise<void> {
  await execFile("git", ["-C", workDir, "push", "origin", branch]);
}

/** Check out a new branch in the work dir, optionally from a specific base. */
export async function checkoutBranch(workDir: string, name: string, from?: string): Promise<void> {
  const args = from
    ? ["-C", workDir, "checkout", "-b", name, from]
    : ["-C", workDir, "checkout", "-b", name];
  await execFile("git", args);
}

export { bareRepoPathFromKey };
