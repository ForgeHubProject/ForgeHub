import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bareRepoPathFromKey } from "./git-storage.js";

const execFile = promisify(execFileCb);
const MAX = 10 * 1024 * 1024;

export async function git(storageKey: string, args: string[]): Promise<string> {
  const cwd = bareRepoPathFromKey(storageKey);
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: MAX });
  return stdout.trim();
}

// ─── branches ────────────────────────────────────────────────────────────────

export type BranchInfo = {
  name: string;
  sha: string;
  subject: string;
  date: string;
  isDefault: boolean;
};

export async function listBranches(storageKey: string): Promise<BranchInfo[]> {
  let defaultBranch = "main";
  try {
    const sym = await git(storageKey, ["symbolic-ref", "--short", "HEAD"]);
    defaultBranch = sym;
  } catch { /* empty repo */ }

  try {
    const out = await git(storageKey, [
      "for-each-ref", "refs/heads/",
      "--sort=-creatordate",
      "--format=%(refname:short)|%(objectname)|%(contents:subject)|%(creatordate:iso)",
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [name, sha, subject, date] = line.split("|");
      return { name, sha: sha.slice(0, 7), subject: subject ?? "", date: date ?? "", isDefault: name === defaultBranch };
    });
  } catch {
    return [];
  }
}

export async function defaultBranch(storageKey: string): Promise<string> {
  try {
    return await git(storageKey, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "main";
  }
}

export async function branchExists(storageKey: string, branch: string): Promise<boolean> {
  try {
    await git(storageKey, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch { return false; }
}

export async function createBranch(storageKey: string, name: string, from: string): Promise<void> {
  await git(storageKey, ["branch", name, from]);
}

export async function deleteBranch(storageKey: string, name: string, force = false): Promise<void> {
  await git(storageKey, ["branch", force ? "-D" : "-d", name]);
}

// Returns all commit SHAs reachable from a branch
export async function branchShas(storageKey: string, branch: string): Promise<string[]> {
  try {
    const out = await git(storageKey, ["log", branch, "--format=%H"]);
    return out.split("\n").filter(Boolean);
  } catch { return []; }
}

// ─── tags ────────────────────────────────────────────────────────────────────

export type TagInfo = {
  name: string;
  sha: string;
  subject: string;
  date: string;
};

export async function listTags(storageKey: string): Promise<TagInfo[]> {
  try {
    const out = await git(storageKey, [
      "for-each-ref", "refs/tags/",
      "--sort=-creatordate",
      "--format=%(refname:short)|%(objectname:short)|%(contents:subject)|%(creatordate:iso)",
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [name, sha, subject, date] = line.split("|");
      return { name, sha, subject: subject ?? "", date: date ?? "" };
    });
  } catch { return []; }
}

export async function createTag(storageKey: string, name: string, sha: string, message?: string): Promise<void> {
  if (message) {
    await git(storageKey, ["tag", "-a", name, sha, "-m", message]);
  } else {
    await git(storageKey, ["tag", name, sha]);
  }
}

export async function deleteTag(storageKey: string, name: string): Promise<void> {
  await git(storageKey, ["tag", "-d", name]);
}

// ─── merge ───────────────────────────────────────────────────────────────────

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; conflicts: true }
  | { ok: false; alreadyMerged: true };

export type MergeStrategy = "ours" | "theirs" | "none";

export async function performMerge(
  storageKey: string,
  fromBranch: string,
  toBranch: string,
  message: string,
  strategy: MergeStrategy = "none",
): Promise<MergeResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "fh-merge-"));

  try {
    // Clone locally and checkout the target branch
    await execFile("git", ["clone", "--no-local", repoPath, tmpDir], { maxBuffer: MAX });
    await execFile("git", ["checkout", toBranch], { cwd: tmpDir, maxBuffer: MAX });

    // Check if already merged (use origin/ prefix — local branch doesn't exist in the clone)
    try {
      await execFile("git", ["merge-base", "--is-ancestor", `origin/${fromBranch}`, "HEAD"], { cwd: tmpDir, maxBuffer: MAX });
      return { ok: false, alreadyMerged: true };
    } catch { /* not ancestor — proceed */ }

    // Attempt merge with explicit identity so git doesn't fail on unconfigured hosts.
    // When a strategy is given, pass -X ours/-X theirs to auto-resolve conflicts.
    const strategyArgs = strategy === "none" ? [] : ["-X", strategy];
    try {
      await execFile("git", [
        "-c", "user.name=ForgeHub",
        "-c", "user.email=merge@forgehub.io",
        "merge", "--no-ff", "-m", message, ...strategyArgs, `origin/${fromBranch}`,
      ], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      return { ok: false, conflicts: true };
    }

    // Push result back to bare repo
    try {
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── fork ────────────────────────────────────────────────────────────────────

export async function cloneMirror(sourceKey: string, destKey: string): Promise<void> {
  const sourcePath = bareRepoPathFromKey(sourceKey);
  const destPath   = bareRepoPathFromKey(destKey);
  const { mkdir }  = await import("node:fs/promises");
  await mkdir(path.dirname(destPath), { recursive: true });
  await execFile("git", ["clone", "--mirror", sourcePath, destPath], { maxBuffer: MAX });
}

// ─── branch SHA lookup for HEAD comparisons ──────────────────────────────────

export async function resolveBranchSha(storageKey: string, branch: string): Promise<string | null> {
  try {
    return await git(storageKey, ["rev-parse", `refs/heads/${branch}`]);
  } catch { return null; }
}

/** Read a UTF-8 file at the tip of a branch (null if missing). */
export async function readFileAtBranch(
  storageKey: string,
  branch: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await git(storageKey, ["show", `${branch}:${filePath}`]);
  } catch {
    return null;
  }
}

/** Paths changed between two branch tips (merge-base..from, plus to-only). */
export async function listFilesDifferingBetweenBranches(
  storageKey: string,
  toBranch: string,
  fromBranch: string,
): Promise<string[]> {
  try {
    const out = await git(storageKey, ["diff", "--name-only", toBranch, fromBranch]);
    return out.split("\n").map((p) => p.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const MERGE_IDENTITY = ["-c", "user.name=ForgeHub", "-c", "user.email=merge@forgehub.io"] as const;

/**
 * Merge fromBranch into toBranch, writing resolved file contents for given paths,
 * then commit and push. Works when merge stops with conflicts (overwrites those paths).
 */
export async function performMergeWithResolvedFiles(
  storageKey: string,
  fromBranch: string,
  toBranch: string,
  message: string,
  resolvedFiles: Record<string, string>,
): Promise<MergeResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "fh-merge-resolve-"));

  try {
    await execFile("git", ["clone", "--no-local", repoPath, tmpDir], { maxBuffer: MAX });
    await execFile("git", ["checkout", toBranch], { cwd: tmpDir, maxBuffer: MAX });

    try {
      await execFile("git", ["merge-base", "--is-ancestor", `origin/${fromBranch}`, "HEAD"], {
        cwd: tmpDir,
        maxBuffer: MAX,
      });
      return { ok: false, alreadyMerged: true };
    } catch {
      /* not merged yet */
    }

    try {
      await execFile(
        "git",
        [...MERGE_IDENTITY, "merge", "--no-ff", "--no-commit", `origin/${fromBranch}`],
        { cwd: tmpDir, maxBuffer: MAX },
      );
    } catch {
      /* conflicts expected — continue with resolved file writes */
    }

    for (const [relPath, content] of Object.entries(resolvedFiles)) {
      const full = path.join(tmpDir, relPath);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }

    await execFile("git", ["add", "-A"], { cwd: tmpDir, maxBuffer: MAX });

    try {
      await execFile("git", [...MERGE_IDENTITY, "commit", "-m", message], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      return { ok: false, conflicts: true };
    }

    try {
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir, maxBuffer: MAX });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
