import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile as execFileCb, spawn } from "node:child_process";
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

/**
 * Create an extra bare repo under the current storage root and stream a linear
 * history of `count` commits into it with `git fast-import` — one process for
 * the whole chain, so a multi-thousand-commit history costs a fraction of a
 * second instead of one `git commit` per revision. The oldest commit is the
 * only one touching `oldestFile`; every newer one rewrites `churnFile`.
 * Returns the storage key.
 */
export async function createDeepHistoryRepo(
  key: string,
  branch: string,
  count: number,
  oldestFile: string,
  churnFile: string,
): Promise<string> {
  const { createBareRepo } = await import("../../git-storage.js");
  const bareRepoPath = await createBareRepo(key);

  let stream = "";
  for (let i = 0; i < count; i++) {
    const message = `c${i}`;
    const body = String(i);
    stream += `commit refs/heads/${branch}\nmark :${i + 1}\n`;
    stream += `committer ForgeHub Test <test@forgehub.io> ${1700000000 + i} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    if (i > 0) stream += `from :${i}\n`;
    stream += `M 100644 inline ${i === 0 ? oldestFile : churnFile}\ndata ${body.length}\n${body}\n\n`;
  }

  await fastImport(bareRepoPath, stream);
  return key;
}

/** Stream a fast-import script into a fresh bare repo under the storage root. */
async function fastImport(bareRepoPath: string, stream: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet"], { cwd: bareRepoPath });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git fast-import exited ${code}`))));
    child.stdin.on("error", reject);
    child.stdin.end(stream);
  });
}

/**
 * A **merged-away** topology: `file` is edited on the mainline, edited again on
 * a side branch, and the two are joined by a merge resolved in favour of the
 * mainline — so the side edit is a real commit touching the path whose content
 * never landed in the tree.
 *
 * This is the shape that tells "the commit git names for this path" apart from
 * "some commit that touched this path". git's history simplification follows a
 * parent the merge is TREESAME to and prunes the rest, so `git log <ref> --
 * <file>` names the mainline edit and never the side edit. The side edit is
 * dated **newer** than the mainline edit on purpose: any rule that ranks
 * candidates by date or by `rev-list` position instead of following TREESAME
 * parents puts the discarded commit first, which is exactly where the code tab
 * reads its header commit from.
 *
 * Subjects: `base`, `REAL main edit`, `DISCARDED side edit`, `merge keeping ours`.
 * Returns the storage key.
 */
export async function createMergedAwayRepo(
  key: string,
  branch: string,
  file: string,
): Promise<string> {
  const { createBareRepo } = await import("../../git-storage.js");
  const bareRepoPath = await createBareRepo(key);

  const who = "committer ForgeHub Test <test@forgehub.io>";
  const inline = (body: string) => `M 100644 inline ${file}\ndata ${body.length}\n${body}\n`;
  const commit = (ref: string, mark: number, when: number, message: string, rest: string) =>
    `commit refs/heads/${ref}\nmark :${mark}\n${who} ${when} +0000\n` +
    `data ${message.length}\n${message}\n${rest}\n`;

  let stream = "";
  stream += commit("_base", 1, 1700000000, "base", inline("base"));
  stream += commit(branch, 2, 1700000100, "REAL main edit", `from :1\n` + inline("main"));
  // Branched off `base`, and dated after the mainline edit.
  stream += commit("_side", 3, 1700000200, "DISCARDED side edit", `from :1\n` + inline("side"));
  // No file op: a fast-import merge starts from its first parent's tree, so the
  // merge keeps the mainline content and discards the side edit.
  stream += commit(branch, 4, 1700000300, "merge keeping ours", `from :2\nmerge :3\n`);

  await fastImport(bareRepoPath, stream);
  return key;
}

/**
 * Like {@link createDeepHistoryRepo} but with a **merge topology**: two
 * independent lineages of `perLineage` commits each, joined by one merge commit
 * at the tip. The second lineage is dated strictly older than the first.
 *
 * `rareFile` is touched only by the **root of the second lineage** — the oldest
 * commit in the repo, reachable from the tip only by following the merge's
 * second parent. `churnFile` is rewritten by every commit of the first lineage.
 * The merge carries both sides' content, so `git log <tip> -- <rareFile>` has to
 * cross the merge into the older lineage to name a commit at all.
 *
 * Returns the storage key.
 */
export async function createMergeHistoryRepo(
  key: string,
  branch: string,
  perLineage: number,
  rareFile: string,
  churnFile: string,
): Promise<string> {
  const { createBareRepo } = await import("../../git-storage.js");
  const bareRepoPath = await createBareRepo(key);

  const who = "committer ForgeHub Test <test@forgehub.io>";
  const inline = (file: string, body: string) =>
    `M 100644 inline ${file}\ndata ${body.length}\n${body}\n`;
  let stream = "";

  // Lineage A — the newer half. Every commit rewrites churnFile.
  for (let i = 0; i < perLineage; i++) {
    const message = `a${i}`;
    stream += `commit refs/heads/_lineage_a\nmark :${i + 1}\n`;
    stream += `${who} ${1800000000 + i} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    if (i > 0) stream += `from :${i}\n`;
    stream += inline(churnFile, String(i)) + "\n";
  }

  // Lineage B — older, and rooted independently (`from <null sha>` makes a root
  // commit, i.e. an unrelated history). Only its root touches rareFile.
  const bChurn = `b-${churnFile}`;
  for (let i = 0; i < perLineage; i++) {
    const mark = perLineage + i + 1;
    const message = `b${i}`;
    stream += `commit refs/heads/_lineage_b\nmark :${mark}\n`;
    stream += `${who} ${1700000000 + i} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    stream += i === 0 ? `from ${"0".repeat(40)}\n` : `from :${mark - 1}\n`;
    stream += (i === 0 ? inline(rareFile, "0") : inline(bChurn, String(i))) + "\n";
  }

  // The merge, newest of all, carrying content from both sides.
  const message = "merge lineage b";
  stream += `commit refs/heads/${branch}\nmark :${2 * perLineage + 1}\n`;
  stream += `${who} 1900000000 +0000\n`;
  stream += `data ${message.length}\n${message}\n`;
  stream += `from :${perLineage}\nmerge :${2 * perLineage}\n`;
  stream += inline(rareFile, "0");
  stream += inline(bChurn, String(perLineage - 1)) + "\n";

  await fastImport(bareRepoPath, stream);
  return key;
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
