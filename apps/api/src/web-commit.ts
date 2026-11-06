import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bareRepoPathFromKey } from "./git-storage.js";
import type { CommitAuthor } from "./git-utils.js";

const execFile = promisify(execFileCb);
const MAX = 64 * 1024 * 1024;
const ZERO = "0".repeat(40);

/**
 * One change a web commit makes (#254): write a file (create or replace),
 * delete a file or folder, or move one (`from` → `path`, optionally with new
 * content).
 */
export type FileChange =
  | { path: string; content: Buffer }
  | { path: string; delete: true }
  | { path: string; from: string; content?: Buffer };

export type WebCommitInput = {
  /** The branch the change starts from. */
  base: string;
  /** The branch it's committed to: `base`, or a new branch made from it. */
  target: string;
  /** `base`'s tip as the editor saw it (full or abbreviated); the commit is refused if it moved. */
  expectedSha?: string | null;
  changes: FileChange[];
  message: string;
  author: CommitAuthor;
};

export type WebCommitResult =
  | { ok: true; sha: string; parent: string | null }
  | { ok: false; reason: "moved" | "exists" | "missing" | "unchanged" | "invalid"; detail?: string };

/**
 * A path a web commit may write: relative, no `.`/`..`/empty segments, never
 * inside `.git`, at most 4096 characters. Returns the normalized path or null.
 */
export function cleanPath(input: string): string | null {
  const p = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p || p.length > 4096) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || s.toLowerCase() === ".git" || s.includes("\0"))) return null;
  return p;
}

/**
 * Commit `changes` on top of `base` and point `target` at it, without a working
 * tree: blobs are written with hash-object, the tree is built in a temporary
 * index from base's tree, and the ref moves with a compare-and-swap update-ref,
 * so a push that landed meanwhile is never overwritten. Server-side writes skip
 * the pre-receive hook, like merges do: the caller enforces branch protection.
 */
export async function commitChanges(storageKey: string, input: WebCommitInput): Promise<WebCommitResult> {
  const repoPath = bareRepoPathFromKey(storageKey);
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFile("git", args, { cwd: repoPath, maxBuffer: MAX, env: env ? { ...process.env, ...env } : process.env })
      .then((r) => r.stdout.trim());

  const parent = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${input.base}^{commit}`]).catch(() => "");
  if (!parent) {
    // Only an empty repository may start without a parent: the first commit.
    const anyRef = await git(["for-each-ref", "--count=1", "refs/heads/"]).catch(() => "");
    if (anyRef) return { ok: false, reason: "missing", detail: `Branch '${input.base}' not found` };
  }
  if (input.expectedSha && parent) {
    // The editor may hold an abbreviated id (the branch list's): resolve it.
    const expected = await git(["rev-parse", "--verify", "--quiet", `${input.expectedSha}^{commit}`]).catch(() => "");
    if (expected !== parent) return { ok: false, reason: "moved" };
  }
  if (input.target !== input.base) {
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${input.target}`]).catch(() => "");
    if (exists) return { ok: false, reason: "exists", detail: `Branch '${input.target}' already exists` };
  }

  const work = await mkdtemp(path.join(tmpdir(), "fh-webcommit-"));
  // A private index. The temp folder doubles as the work tree that some index
  // commands insist on (update-index --force-remove); nothing is checked out.
  const env = { GIT_INDEX_FILE: path.join(work, "index"), GIT_WORK_TREE: work };
  try {
    await git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);

    /** Mode and blob of a path at the parent, or null. */
    const entryAt = async (p: string): Promise<{ mode: string; sha: string } | null> => {
      if (!parent) return null;
      const line = await git(["ls-tree", parent, "--", p]).catch(() => "");
      const m = /^(\d+) blob ([0-9a-f]{40})\t/.exec(line);
      return m ? { mode: m[1], sha: m[2] } : null;
    };
    const filesUnder = async (p: string): Promise<string[]> => {
      if (!parent) return [];
      const out = await git(["ls-tree", "-r", "--name-only", parent, "--", p]).catch(() => "");
      return out.split("\n").filter((f) => f === p || f.startsWith(`${p}/`));
    };
    let blobCount = 0;
    const writeBlob = async (content: Buffer): Promise<string> => {
      const file = path.join(work, `blob-${blobCount++}`);
      await writeFile(file, content);
      return git(["hash-object", "-w", "--", file]);
    };
    const put = (mode: string, sha: string, p: string) =>
      git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${p}`], env);
    const remove = (p: string) => git(["update-index", "--force-remove", "--", p], env);

    for (const change of input.changes) {
      const target = cleanPath(change.path);
      if (!target) return { ok: false, reason: "invalid", detail: `Invalid path '${change.path}'` };

      if ("delete" in change) {
        const files = await filesUnder(target);
        if (files.length === 0) return { ok: false, reason: "missing", detail: `'${target}' does not exist` };
        for (const f of files) await remove(f);
      } else if ("from" in change) {
        const from = cleanPath(change.from);
        if (!from) return { ok: false, reason: "invalid", detail: `Invalid path '${change.from}'` };
        const old = await entryAt(from);
        if (!old) return { ok: false, reason: "missing", detail: `'${from}' does not exist` };
        if (from !== target && (await entryAt(target))) {
          return { ok: false, reason: "exists", detail: `'${target}' already exists` };
        }
        const sha = change.content ? await writeBlob(change.content) : old.sha;
        await remove(from);
        await put(old.mode, sha, target);
      } else {
        const old = await entryAt(target);
        await put(old?.mode ?? "100644", await writeBlob(change.content), target);
      }
    }

    let tree: string;
    try {
      tree = await git(["write-tree"], env);
    } catch (err) {
      // A file where a folder is (or the reverse): git refuses the index.
      return { ok: false, reason: "invalid", detail: err instanceof Error ? err.message.split("\n")[0] : undefined };
    }
    if (parent && tree === (await git(["rev-parse", `${parent}^{tree}`]))) return { ok: false, reason: "unchanged" };

    const who = {
      GIT_AUTHOR_NAME: input.author.name, GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name, GIT_COMMITTER_EMAIL: input.author.email,
    };
    const sha = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", input.message], who);

    // Compare-and-swap: the target must still be where we read it (or absent, for a new branch).
    const expectedOld = input.target === input.base ? (parent || ZERO) : ZERO;
    try {
      await git(["update-ref", `refs/heads/${input.target}`, sha, expectedOld]);
    } catch {
      return { ok: false, reason: "moved" };
    }
    // A first commit into an empty repo names its default branch.
    if (!parent) await git(["symbolic-ref", "HEAD", `refs/heads/${input.target}`]).catch(() => {});
    return { ok: true, sha, parent: parent || null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
