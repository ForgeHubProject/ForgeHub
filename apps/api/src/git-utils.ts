import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bareRepoPathFromKey } from "./git-storage.js";
import { loadActiveFormats } from "./forge-formats.js";
import { firstHandlerForPathAndFormats } from "./handlers/index.js";

const execFile = promisify(execFileCb);
const MAX = 10 * 1024 * 1024;

/**
 * Environment for server-side pushes to a bare repo (merge/squash/rebase/revert).
 * These are the sanctioned merge path, so they carry `FORGEHUB_INTERNAL_PUSH=1`
 * to bypass the branch-protection pre-receive hook (issue #85) — protection
 * gates the merge at the endpoint, not the internal ref write.
 */
const INTERNAL_PUSH_ENV = { ...process.env, FORGEHUB_INTERNAL_PUSH: "1" };

export async function git(storageKey: string, args: string[]): Promise<string> {
  const cwd = bareRepoPathFromKey(storageKey);
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: MAX });
  return stdout.trim();
}

// ─── branches ────────────────────────────────────────────────────────────────────────────

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

// ─── tags ───────────────────────────────────────────────────────────────────────────────

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

export async function tagExists(storageKey: string, name: string): Promise<boolean> {
  try {
    await git(storageKey, ["rev-parse", "--verify", `refs/tags/${name}`]);
    return true;
  } catch { return false; }
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

// ─── merge ───────────────────────────────────────────────────────────────────────────────

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; conflicts: true }
  | { ok: false; alreadyMerged: true };

export type MergeStrategy = "ours" | "theirs" | "none";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Identity used to author generated commits (squash commit, revert commit). */
export type CommitAuthor = { name: string; email: string };

function identityArgs(author: CommitAuthor): string[] {
  return [
    "-c", `user.name=${author.name}`,
    "-c", `user.email=${author.email}`,
    "-c", "commit.gpgsign=false",
  ];
}

export type RevertResult =
  | { ok: true; branch: string; sha: string }
  | { ok: false; conflicts: true };

const MERGE_IDENTITY = ["-c", "user.name=ForgeHub", "-c", "user.email=merge@forgehub.io", "-c", "commit.gpgsign=false"] as const;

// The repo's opt-in extension set at a commit, for scoping handler resolution.
export async function activeFormatsAtCommit(storageKey: string, commitIsh: string): Promise<Set<string>> {
  return loadActiveFormats(bareRepoPathFromKey(storageKey), commitIsh);
}

function readStageBuffer(dir: string, stage: 1 | 2 | 3, file: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFileCb(
      "git",
      ["show", `:${stage}:${file}`],
      { cwd: dir, maxBuffer: MAX, encoding: "buffer" },
      (err, stdout) => {
        resolve(err ? null : (stdout as unknown as Buffer));
      },
    );
  });
}

// Attempt to resolve all conflicted files using their semantic handler.
// Returns true only if every conflict was resolved; false if any are unresolvable.
async function trySemanticResolve(tmpDir: string): Promise<boolean> {
  const activeExts = await loadActiveFormats(tmpDir, "HEAD");
  if (activeExts.size === 0) return false;

  let conflicted: string[];
  try {
    const { stdout } = await execFile(
      "git", ["diff", "--name-only", "--diff-filter=U"],
      { cwd: tmpDir, maxBuffer: MAX },
    );
    conflicted = stdout.trim().split("\n").filter(Boolean);
  } catch {
    return false;
  }
  if (conflicted.length === 0) return true;

  for (const file of conflicted) {
    const handler = firstHandlerForPathAndFormats(file, activeExts);
    if (!handler?.merge || !handler.capabilities.semanticMerge) return false;

    const [base, ours, theirs] = await Promise.all([
      readStageBuffer(tmpDir, 1, file),
      readStageBuffer(tmpDir, 2, file),
      readStageBuffer(tmpDir, 3, file),
    ]);
    if (!ours || !theirs) return false;

    let result;
    try {
      result = await handler.merge(base ?? Buffer.alloc(0), ours, theirs);
    } catch {
      return false;
    }

    // If the handler itself reports unresolved semantic conflicts, bubble up
    if (result.conflicts && result.conflicts.conflicts.length > 0) return false;

    const fullPath = path.join(tmpDir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, result.blob);
    await execFile("git", ["add", "--", file], { cwd: tmpDir, maxBuffer: MAX });
  }

  return true;
}

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

    const strategyArgs = strategy === "none" ? [] : ["-X", strategy];
    let mergeClean = true;
    try {
      await execFile("git", [
        ...MERGE_IDENTITY,
        "merge", "--no-ff", "-m", message, ...strategyArgs, `origin/${fromBranch}`,
      ], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      mergeClean = false;
    }

    if (!mergeClean) {
      // Try resolving conflicts semantically for handler-supported formats
      const resolved = await trySemanticResolve(tmpDir);
      if (!resolved) return { ok: false, conflicts: true };

      try {
        await execFile("git", [...MERGE_IDENTITY, "commit", "-m", message], { cwd: tmpDir, maxBuffer: MAX });
      } catch {
        return { ok: false, conflicts: true };
      }
    }

    // Push result back to bare repo
    try {
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX, env: INTERNAL_PUSH_ENV });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Squash-merge: collapse every commit unique to `fromBranch` into a single new
 * commit on `toBranch`, authored/committed as `author`. No merge commit is
 * created — the result has exactly one new commit whose parent is the prior
 * `toBranch` tip. Conflicts route through the same semantic-resolve path as
 * `performMerge`; unresolved conflicts yield `{ ok:false, conflicts:true }`.
 */
export async function performSquashMerge(
  storageKey: string,
  fromBranch: string,
  toBranch: string,
  message: string,
  author: CommitAuthor,
): Promise<MergeResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "fh-squash-"));

  try {
    await execFile("git", ["clone", "--no-local", repoPath, tmpDir], { maxBuffer: MAX });
    await execFile("git", ["checkout", toBranch], { cwd: tmpDir, maxBuffer: MAX });

    // Already merged? (from is an ancestor of the base tip)
    try {
      await execFile("git", ["merge-base", "--is-ancestor", `origin/${fromBranch}`, "HEAD"], { cwd: tmpDir, maxBuffer: MAX });
      return { ok: false, alreadyMerged: true };
    } catch { /* not merged — proceed */ }

    let clean = true;
    try {
      await execFile("git", [...MERGE_IDENTITY, "merge", "--squash", `origin/${fromBranch}`], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      clean = false;
    }

    if (!clean) {
      const resolved = await trySemanticResolve(tmpDir);
      if (!resolved) return { ok: false, conflicts: true };
    }

    // --squash stages the changes without committing; author the single commit as the merger.
    try {
      await execFile("git", [...identityArgs(author), "commit", "-m", message], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      // Nothing staged (empty squash) or commit failed — treat as a conflict/no-op.
      return { ok: false, conflicts: true };
    }

    try {
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX, env: INTERNAL_PUSH_ENV });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Rebase-merge: replay the commits unique to `fromBranch` on top of `toBranch`,
 * then fast-forward `toBranch` to the replayed tip — no merge commit, original
 * commit subjects/authors preserved. If the replay conflicts, the rebase is
 * aborted and `toBranch` is left completely untouched (`{ ok:false, conflicts:true }`).
 */
export async function performRebaseMerge(
  storageKey: string,
  fromBranch: string,
  toBranch: string,
): Promise<MergeResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "fh-rebase-"));

  try {
    await execFile("git", ["clone", "--no-local", repoPath, tmpDir], { maxBuffer: MAX });
    await execFile("git", ["checkout", toBranch], { cwd: tmpDir, maxBuffer: MAX });

    try {
      await execFile("git", ["merge-base", "--is-ancestor", `origin/${fromBranch}`, "HEAD"], { cwd: tmpDir, maxBuffer: MAX });
      return { ok: false, alreadyMerged: true };
    } catch { /* not merged — proceed */ }

    // Replay fromBranch's commits onto toBranch on a scratch branch.
    await execFile("git", ["checkout", "-B", "_fh_replay", `origin/${fromBranch}`], { cwd: tmpDir, maxBuffer: MAX });
    try {
      await execFile("git", [...MERGE_IDENTITY, "rebase", toBranch], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      await execFile("git", ["rebase", "--abort"], { cwd: tmpDir, maxBuffer: MAX }).catch(() => {});
      return { ok: false, conflicts: true };
    }

    // Fast-forward the base branch to the replayed tip and push.
    await execFile("git", ["checkout", toBranch], { cwd: tmpDir, maxBuffer: MAX });
    try {
      await execFile("git", ["merge", "--ff-only", "_fh_replay"], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      return { ok: false, conflicts: true };
    }

    try {
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX, env: INTERNAL_PUSH_ENV });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Create `newBranch` off `baseBranch`'s tip and `git revert` the commit at
 * `targetSha` onto it, then push. Merge commits (2+ parents) are reverted with
 * `-m 1`; squash/rebase single-parent commits are reverted plainly. On a revert
 * conflict the operation is aborted and nothing is pushed (`baseBranch`
 * untouched), returning `{ ok:false, conflicts:true }`.
 */
export async function performRevert(
  storageKey: string,
  baseBranch: string,
  targetSha: string,
  newBranch: string,
  author: CommitAuthor,
): Promise<RevertResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "fh-revert-"));

  try {
    await execFile("git", ["clone", "--no-local", repoPath, tmpDir], { maxBuffer: MAX });
    await execFile("git", ["checkout", baseBranch], { cwd: tmpDir, maxBuffer: MAX });
    await execFile("git", ["checkout", "-b", newBranch], { cwd: tmpDir, maxBuffer: MAX });

    // Merge commits need a mainline (-m 1); ordinary commits are reverted directly.
    const { stdout: parentsOut } = await execFile("git", ["rev-list", "--parents", "-n", "1", targetSha], { cwd: tmpDir, maxBuffer: MAX });
    const parentCount = parentsOut.trim().split(/\s+/).length - 1;
    const revertArgs = parentCount >= 2
      ? ["revert", "-m", "1", "--no-edit", targetSha]
      : ["revert", "--no-edit", targetSha];

    try {
      await execFile("git", [...identityArgs(author), ...revertArgs], { cwd: tmpDir, maxBuffer: MAX });
    } catch {
      await execFile("git", ["revert", "--abort"], { cwd: tmpDir, maxBuffer: MAX }).catch(() => {});
      return { ok: false, conflicts: true };
    }

    try {
      await execFile("git", ["push", "origin", newBranch], { cwd: tmpDir, maxBuffer: MAX, env: INTERNAL_PUSH_ENV });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    return { ok: true, branch: newBranch, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── fork ───────────────────────────────────────────────────────────────────────────────

export async function cloneMirror(sourceKey: string, destKey: string): Promise<void> {
  const sourcePath = bareRepoPathFromKey(sourceKey);
  const destPath   = bareRepoPathFromKey(destKey);
  const { mkdir }  = await import("node:fs/promises");
  await mkdir(path.dirname(destPath), { recursive: true });
  await execFile("git", ["clone", "--mirror", sourcePath, destPath], { maxBuffer: MAX });
}

// ─── fork sync (upstream tracking, issue #113) ─────────────────────────────────

export type ForkSyncStatus = "up-to-date" | "fast-forwarded" | "diverged";

export type ForkSyncResult = {
  status: ForkSyncStatus;
  ahead: number;
  behind: number;
  /** The branch that was synced (the parent's default branch). */
  branch: string;
  /** The fork's branch tip before the sync (null when the branch didn't exist). */
  oldSha: string | null;
  /** The fork's branch tip after the sync (== oldSha unless fast-forwarded). */
  newSha: string | null;
};

/**
 * Sync a fork's default branch from its upstream parent. Both repos are local
 * bare dirs, so the parent's branch is fetched directly by path into the fork's
 * object store (no ref is written by the fetch — it lands in FETCH_HEAD). The
 * fork's branch is fast-forwarded **only** when it is strictly behind (no local
 * commits of its own); history is never rewritten.
 *
 *  - `up-to-date`     the fork already contains the upstream tip (behind == 0)
 *  - `fast-forwarded` the fork was behind-only and its branch ref was advanced
 *  - `diverged`       the fork has local commits upstream lacks (behind>0 && ahead>0)
 *
 * On a fast-forward, `oldSha`→`newSha` brackets the pulled range so the caller
 * can re-ingest artifacts and emit push events, exactly like a client push.
 * ahead/behind are measured with the fork's branch as `head` and the upstream
 * tip as `base` (ahead = commits only on the fork, behind = commits only upstream).
 */
export async function syncForkBranch(forkKey: string, parentKey: string): Promise<ForkSyncResult> {
  const parentPath = bareRepoPathFromKey(parentKey);
  const branch = await defaultBranch(parentKey);

  // Fetch the parent's default branch into FETCH_HEAD without moving any ref.
  await git(forkKey, ["fetch", parentPath, branch]);
  const upstreamSha = await git(forkKey, ["rev-parse", "FETCH_HEAD"]);

  const oldSha = await resolveBranchSha(forkKey, branch);

  // The branch didn't exist on the fork yet (empty at fork time): create it at
  // the upstream tip — a fast-forward from nothing.
  if (!oldSha) {
    await git(forkKey, ["update-ref", `refs/heads/${branch}`, upstreamSha]);
    return { status: "fast-forwarded", ahead: 0, behind: 0, branch, oldSha: null, newSha: upstreamSha };
  }

  const { ahead, behind } = await countAheadBehind(forkKey, upstreamSha, branch);

  // Already contains everything upstream has (it may be ahead — nothing to pull).
  if (behind === 0) {
    return { status: "up-to-date", ahead, behind, branch, oldSha, newSha: oldSha };
  }
  // Behind AND ahead — local commits would be lost by a fast-forward. Refuse.
  if (ahead > 0) {
    return { status: "diverged", ahead, behind, branch, oldSha, newSha: oldSha };
  }

  // Behind-only → advance the fork's branch ref to the upstream tip. The old-value
  // guard makes the update atomic against a concurrent write.
  await git(forkKey, ["update-ref", `refs/heads/${branch}`, upstreamSha, oldSha]);
  return { status: "fast-forwarded", ahead, behind, branch, oldSha, newSha: upstreamSha };
}

// ─── branch SHA lookup for HEAD comparisons ────────────────────────────────────────────

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

// ─── commits ─────────────────────────────────────────────────────────────────────────────

export type CommitInfo = {
  sha: string;
  shortSha: string;
  subject: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parents: string[];
};

export async function listCommits(
  storageKey: string,
  ref: string,
  options: { page?: number; perPage?: number } = {},
): Promise<CommitInfo[]> {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 20));
  const skip = (page - 1) * perPage;
  try {
    // \x1f (unit separator) won't appear in git metadata fields
    const out = await git(storageKey, [
      "log", ref,
      `--skip=${skip}`, `-n`, String(perPage),
      "--format=%H\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%P",
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, subject, authorName, authorEmail, date, parents] = line.split("\x1f");
      return {
        sha: sha ?? "",
        shortSha: (sha ?? "").slice(0, 7),
        subject: subject ?? "",
        message: subject ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        parents: parents?.trim() ? parents.trim().split(" ") : [],
      };
    });
  } catch {
    return [];
  }
}

export async function getCommit(
  storageKey: string,
  sha: string,
): Promise<(CommitInfo & { changedFiles: string[] }) | null> {
  try {
    const meta = await git(storageKey, [
      "show", "--no-patch", "--format=%H\x1f%an\x1f%ae\x1f%aI\x1f%P", sha,
    ]);
    const [fullSha, authorName, authorEmail, date, parents] = meta.split("\x1f");
    const fullMsg = await git(storageKey, ["show", "--no-patch", "--format=%B", sha]);
    const subject = fullMsg.split("\n")[0]?.trim() ?? "";
    const filesOut = await git(storageKey, ["diff-tree", "--no-commit-id", "-r", "--name-only", sha]);
    return {
      sha: fullSha ?? "",
      shortSha: (fullSha ?? "").slice(0, 7),
      subject,
      message: fullMsg.trim(),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      parents: parents?.trim() ? parents.trim().split(" ") : [],
      changedFiles: filesOut.split("\n").filter(Boolean),
    };
  } catch {
    return null;
  }
}

// ─── commit diff ────────────────────────────────────────────────────────────────────────────

export type DiffLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  oldPath: string;
  newPath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
};

function parseDiff(raw: string): FileDiff[] {
  const result: FileDiff[] = [];
  const sections: string[] = [];

  let lastIndex = 0;
  const pattern = /^diff --git /gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    if (m.index > lastIndex) sections.push(raw.slice(lastIndex, m.index));
    lastIndex = m.index;
  }
  sections.push(raw.slice(lastIndex));

  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue;
    const lines = section.split("\n");
    const headerMatch = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!headerMatch) continue;

    let oldPath = headerMatch[1];
    let newPath = headerMatch[2];
    let status: FileDiff["status"] = "modified";
    let binary = false;
    let additions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLineNo = 1;
    let newLineNo = 1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("new file mode")) {
        status = "added";
      } else if (line.startsWith("deleted file mode")) {
        status = "deleted";
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = line.slice(12);
      } else if (line.startsWith("rename to ")) {
        newPath = line.slice(10);
      } else if (line.includes("Binary files")) {
        binary = true;
      } else if (line.startsWith("@@ ")) {
        const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        oldLineNo = hm ? parseInt(hm[1], 10) : 1;
        newLineNo = hm ? parseInt(hm[2], 10) : 1;
        currentHunk = { header: line, lines: [] };
        hunks.push(currentHunk);
      } else if (currentHunk) {
        if (line.startsWith("+")) {
          additions++;
          currentHunk.lines.push({ type: "add", content: line.slice(1), oldLineNo: null, newLineNo: newLineNo++ });
        } else if (line.startsWith("-")) {
          deletions++;
          currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLineNo: oldLineNo++, newLineNo: null });
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLineNo++, newLineNo: newLineNo++ });
        }
      }
    }

    result.push({ oldPath, newPath, status, binary, additions, deletions, hunks });
  }

  return result;
}

export async function getCommitDiff(storageKey: string, sha: string): Promise<FileDiff[]> {
  try {
    const patch = await git(storageKey, ["show", "--patch", "--format=", sha]);
    return parseDiff(patch);
  } catch {
    return [];
  }
}

// ─── PR merge-base helpers ────────────────────────────────────────────────────────────

export type PRFileEntry = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: "added" | "modified" | "deleted" | "renamed";
};

/** File list with stats only (no diff content) using merge-base. */
export async function getMergeBaseFileList(
  storageKey: string,
  toBranch: string,
  fromBranch: string,
): Promise<PRFileEntry[]> {
  try {
    const mergeBase = await git(storageKey, ["merge-base", toBranch, fromBranch]);
    if (!mergeBase) return [];

    // Run name-status and numstat in parallel
    const [nameStatusOut, numstatOut] = await Promise.all([
      git(storageKey, ["diff", "--name-status", "-M", mergeBase, fromBranch]),
      git(storageKey, ["diff", "--numstat", "-M", mergeBase, fromBranch]),
    ]);

    // Parse name-status: A\tpath | M\tpath | D\tpath | R100\toldPath\tnewPath
    const statusMap = new Map<string, { status: PRFileEntry["status"]; oldPath?: string }>();
    for (const line of nameStatusOut.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const code = parts[0];
      if (!code) continue;
      if (code === "A") {
        statusMap.set(parts[1], { status: "added" });
      } else if (code === "M") {
        statusMap.set(parts[1], { status: "modified" });
      } else if (code === "D") {
        statusMap.set(parts[1], { status: "deleted" });
      } else if (code.startsWith("R")) {
        const oldPath = parts[1];
        const newPath = parts[2];
        statusMap.set(newPath, { status: "renamed", oldPath });
      }
    }

    // Parse numstat: additions\tdeletions\tpath (binary: -\t-\tpath)
    const entries: PRFileEntry[] = [];
    for (const line of numstatOut.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [addStr, delStr, filePath] = parts;
      const binary = addStr === "-" && delStr === "-";
      const additions = binary ? 0 : parseInt(addStr ?? "0", 10);
      const deletions = binary ? 0 : parseInt(delStr ?? "0", 10);
      const info = statusMap.get(filePath ?? "") ?? { status: "modified" as const };
      entries.push({
        path: filePath ?? "",
        ...(info.oldPath ? { oldPath: info.oldPath } : {}),
        additions,
        deletions,
        binary,
        status: info.status,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/** Full or single-file diff using merge-base. */
export async function getMergeBaseDiff(
  storageKey: string,
  toBranch: string,
  fromBranch: string,
  filePath?: string,
): Promise<FileDiff[]> {
  try {
    const mergeBase = await git(storageKey, ["merge-base", toBranch, fromBranch]);
    if (!mergeBase) return [];
    const args = ["diff", "--patch", mergeBase, fromBranch];
    if (filePath) args.push("--", filePath);
    const patch = await git(storageKey, args);
    return parseDiff(patch);
  } catch {
    return [];
  }
}

/** Only commits in the PR (between merge-base and fromBranch tip). */
export async function listMergeBaseCommits(
  storageKey: string,
  toBranch: string,
  fromBranch: string,
): Promise<CommitInfo[]> {
  try {
    const mergeBase = await git(storageKey, ["merge-base", toBranch, fromBranch]);
    if (!mergeBase) return [];
    const out = await git(storageKey, [
      "log", `${mergeBase}..${fromBranch}`,
      "--format=%H\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%P",
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, subject, authorName, authorEmail, date, parents] = line.split("\x1f");
      return {
        sha: sha ?? "",
        shortSha: (sha ?? "").slice(0, 7),
        subject: subject ?? "",
        message: subject ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        parents: parents?.trim() ? parents.trim().split(" ") : [],
      };
    });
  } catch {
    return [];
  }
}

// ─── release notes ───────────────────────────────────────────────────────────────────────

/**
 * The nearest tag reachable from `${targetRef}^` — i.e. the previous release
 * tag before `targetRef`. Returns null when there is no earlier tag (root).
 */
export async function resolvePreviousTag(storageKey: string, targetRef: string): Promise<string | null> {
  try {
    const out = await git(storageKey, ["describe", "--tags", "--abbrev=0", `${targetRef}^`]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commits reachable from `toRef` but not from `fromRef` (`fromRef..toRef`).
 * When `fromRef` is null, returns the full history of `toRef` (from the root).
 */
export async function listRangeCommits(
  storageKey: string,
  fromRef: string | null,
  toRef: string,
): Promise<CommitInfo[]> {
  try {
    const range = fromRef ? `${fromRef}..${toRef}` : toRef;
    const out = await git(storageKey, [
      "log", range,
      "--format=%H\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%P",
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, subject, authorName, authorEmail, date, parents] = line.split("\x1f");
      return {
        sha: sha ?? "",
        shortSha: (sha ?? "").slice(0, 7),
        subject: subject ?? "",
        message: subject ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        parents: parents?.trim() ? parents.trim().split(" ") : [],
      };
    });
  } catch {
    return [];
  }
}

// ─── file tree ─────────────────────────────────────────────────────────────────────────────

export type TreeEntry = {
  mode: string;
  type: "blob" | "tree";
  sha: string;
  path: string;
  name: string;
};

export async function listTree(
  storageKey: string,
  ref: string,
  treePath: string,
): Promise<TreeEntry[]> {
  try {
    // trailing slash lists directory contents; no arg lists root
    const args = treePath
      ? ["ls-tree", ref, "--", treePath.replace(/\/$/, "") + "/"]
      : ["ls-tree", ref];
    const out = await git(storageKey, args);
    if (!out) return [];
    const prefix = treePath ? treePath.replace(/\/$/, "") + "/" : "";
    return out.split("\n").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha] = line.slice(0, tab).split(" ");
      // git ls-tree always returns the full path from repo root
      const fullPath = line.slice(tab + 1);
      const name = prefix ? fullPath.slice(prefix.length) : fullPath;
      return { mode: mode ?? "", type: (type ?? "blob") as "blob" | "tree", sha: sha ?? "", path: fullPath, name };
    });
  } catch {
    return [];
  }
}

export type BlobSize = { path: string; size: number };

/**
 * Every blob reachable from a ref with its byte size, via `git ls-tree -r -l`.
 * Output rows are `<mode> blob <sha> <size>\t<path>` (size right-aligned/padded);
 * trees are excluded by -r. Drives the format composition bar. Empty on error.
 */
export async function listBlobSizes(storageKey: string, ref: string): Promise<BlobSize[]> {
  try {
    const out = await git(storageKey, ["ls-tree", "-r", "-l", ref]);
    if (!out) return [];
    const result: BlobSize[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      // meta = [mode, type, sha, size]; size is padded so split on runs of space
      const meta = line.slice(0, tab).trim().split(/\s+/);
      if (meta[1] !== "blob") continue;
      const size = parseInt(meta[3] ?? "0", 10);
      result.push({ path: line.slice(tab + 1), size: Number.isFinite(size) ? size : 0 });
    }
    return result;
  } catch {
    return [];
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
      await execFile("git", ["push", "origin", toBranch], { cwd: tmpDir, maxBuffer: MAX, env: INTERNAL_PUSH_ENV });
    } catch {
      return { ok: false, conflicts: true };
    }

    const { stdout: sha } = await execFile("git", ["rev-parse", "HEAD"], { cwd: tmpDir, maxBuffer: MAX });
    return { ok: true, sha: sha.trim() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── blob helpers (for handler.diff()) ───────────────────────────────────────────────

/** Resolve the git blob SHA for a file at a specific commit. */
export async function resolveBlobSha(
  storageKey: string,
  commitSha: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await git(storageKey, ["rev-parse", `${commitSha}:${filePath}`]);
  } catch {
    return null;
  }
}

/** Read raw file content as a Buffer for a specific commit. Supports binary files. */
export function readBlobAsBuffer(
  storageKey: string,
  commitSha: string,
  filePath: string,
): Promise<Buffer | null> {
  const cwd = bareRepoPathFromKey(storageKey);
  return new Promise((resolve) => {
    execFileCb(
      "git",
      ["show", `${commitSha}:${filePath}`],
      { cwd, maxBuffer: MAX, encoding: "buffer" },
      (err, stdout) => {
        resolve(err ? null : (stdout as unknown as Buffer));
      },
    );
  });
}

// ─── ref resolution ─────────────────────────────────────────────────────────

/**
 * Resolve any ref-ish (branch, tag, short/long SHA) to its full 40-char commit
 * SHA — the canonical id a permalink pins to so it never rots. Returns null when
 * the ref can't be resolved. Unlike `resolveBranchSha`, this accepts any revision.
 */
export async function resolveRefSha(storageKey: string, ref: string): Promise<string | null> {
  try {
    const sha = await git(storageKey, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// ─── blame ───────────────────────────────────────────────────────────────────

/** A contiguous run of lines attributed to a single commit. */
export type BlameHunk = {
  sha: string;
  shortSha: string;
  author: string;
  authorMail: string;
  date: string; // ISO 8601, from the author time
  summary: string;
  startLine: number; // 1-based, inclusive (final file line numbers)
  endLine: number; // 1-based, inclusive
  lines: string[]; // the source lines in this hunk, in order
};

type BlameCommitMeta = {
  author?: string;
  authorMail?: string;
  authorTime?: string;
  summary?: string;
};

/**
 * Parse `git blame --porcelain` output into contiguous per-commit hunks. The
 * porcelain format emits, for each result line, a header
 * `<sha> <origLine> <finalLine> [<groupSize>]` followed (only the first time a
 * commit is seen) by its metadata block, then a TAB-prefixed content line.
 */
export function parseBlamePorcelain(raw: string): BlameHunk[] {
  const rawLines = raw.split("\n");
  const commits = new Map<string, BlameCommitMeta>();
  type LineEntry = { sha: string; finalLine: number; content: string };
  const entries: LineEntry[] = [];

  let i = 0;
  while (i < rawLines.length) {
    const header = rawLines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (!header) { i++; continue; }
    const sha = header[1];
    const finalLine = parseInt(header[2], 10);
    if (!commits.has(sha)) commits.set(sha, {});
    const meta = commits.get(sha)!;
    i++;
    // Metadata block (present only the first time this commit appears), until the
    // TAB-prefixed content line.
    while (i < rawLines.length && !rawLines[i].startsWith("\t")) {
      const line = rawLines[i];
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? "" : line.slice(sp + 1);
      if (key === "author") meta.author = val;
      else if (key === "author-mail") meta.authorMail = val.replace(/^<|>$/g, "");
      else if (key === "author-time") meta.authorTime = val;
      else if (key === "summary") meta.summary = val;
      i++;
    }
    if (i < rawLines.length && rawLines[i].startsWith("\t")) {
      entries.push({ sha, finalLine, content: rawLines[i].slice(1) });
      i++;
    }
  }

  // Coalesce consecutive same-commit lines into hunks.
  const hunks: BlameHunk[] = [];
  for (const e of entries) {
    const prev = hunks[hunks.length - 1];
    if (prev && prev.sha === e.sha && e.finalLine === prev.endLine + 1) {
      prev.endLine = e.finalLine;
      prev.lines.push(e.content);
      continue;
    }
    const meta = commits.get(e.sha) ?? {};
    const t = meta.authorTime ? parseInt(meta.authorTime, 10) : NaN;
    hunks.push({
      sha: e.sha,
      shortSha: e.sha.slice(0, 7),
      author: meta.author ?? "",
      authorMail: meta.authorMail ?? "",
      date: Number.isFinite(t) ? new Date(t * 1000).toISOString() : "",
      summary: meta.summary ?? "",
      startLine: e.finalLine,
      endLine: e.finalLine,
      lines: [e.content],
    });
  }
  return hunks;
}

/** Line-level authorship for a file at a ref, as contiguous commit hunks. */
export async function getBlame(
  storageKey: string,
  ref: string,
  filePath: string,
): Promise<BlameHunk[]> {
  try {
    const raw = await git(storageKey, ["blame", "--porcelain", ref, "--", filePath]);
    return parseBlamePorcelain(raw);
  } catch {
    return [];
  }
}

// ─── ahead / behind ───────────────────────────────────────────────────────────

export type AheadBehind = { ahead: number; behind: number };

/**
 * Commits `head` is ahead of / behind `base`, via
 * `git rev-list --left-right --count base...head` (left = base-only = behind,
 * right = head-only = ahead). Returns zeros when the refs don't resolve.
 */
export async function countAheadBehind(
  storageKey: string,
  base: string,
  head: string,
): Promise<AheadBehind> {
  try {
    const out = await git(storageKey, ["rev-list", "--left-right", "--count", `${base}...${head}`]);
    const [left, right] = out.trim().split(/\s+/).map((n) => parseInt(n, 10));
    return { behind: Number.isFinite(left) ? left : 0, ahead: Number.isFinite(right) ? right : 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

// ─── ref-to-ref compare ───────────────────────────────────────────────────────

export type RefCompare = {
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  ahead: number;
  behind: number;
  identical: boolean;
  commits: CommitInfo[];
  files: PRFileEntry[];
};

/**
 * Compare any two refs the way GitHub's /compare does: the commit list and file
 * changes are measured from the merge-base of `base` and `head` up to `head`
 * (three-dot), so only what `head` introduces shows. Ahead/behind is relative to
 * `base`. Reuses the same merge-base machinery PRs are built on.
 */
export async function compareRefs(
  storageKey: string,
  base: string,
  head: string,
): Promise<RefCompare | null> {
  const [baseSha, headSha] = await Promise.all([
    resolveRefSha(storageKey, base),
    resolveRefSha(storageKey, head),
  ]);
  if (!baseSha || !headSha) return null;

  let mergeBaseSha: string | null = null;
  try {
    mergeBaseSha = await git(storageKey, ["merge-base", base, head]);
  } catch { mergeBaseSha = null; }

  const [{ ahead, behind }, commits, files] = await Promise.all([
    countAheadBehind(storageKey, base, head),
    listMergeBaseCommits(storageKey, base, head),
    getMergeBaseFileList(storageKey, base, head),
  ]);

  return {
    base,
    head,
    baseSha,
    headSha,
    mergeBaseSha,
    ahead,
    behind,
    identical: baseSha === headSha,
    commits,
    files,
  };
}
