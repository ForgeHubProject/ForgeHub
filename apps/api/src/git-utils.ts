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

// ─── fork ───────────────────────────────────────────────────────────────────────────────

export async function cloneMirror(sourceKey: string, destKey: string): Promise<void> {
  const sourcePath = bareRepoPathFromKey(sourceKey);
  const destPath   = bareRepoPathFromKey(destKey);
  const { mkdir }  = await import("node:fs/promises");
  await mkdir(path.dirname(destPath), { recursive: true });
  await execFile("git", ["clone", "--mirror", sourcePath, destPath], { maxBuffer: MAX });
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
