import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { installPreReceiveHook } from "./git-hooks.js";

const execFile = promisify(execFileCb);

function storageRoot(): string {
  return process.env["GIT_STORAGE_ROOT"]?.trim() || path.resolve(process.cwd(), "git-storage");
}

// ─── release asset storage ───────────────────────────────────────────────────
//
// Asset bytes live on the filesystem under a sibling of the git storage root
// (`<root>-assets`), never inside the bare repos. A storage key is a relative
// path `<repoSegment>/<releaseId>/<name>` mirroring the bare-repo layout.

function assetsRoot(): string {
  return `${path.resolve(storageRoot())}-assets`;
}

/** Build the relative storage key for a release asset. */
export function buildAssetStorageKey(repoRef: string, releaseId: string, assetName: string): string {
  const repoSegment = repoRef.replace(/\.git$/, "");
  return `${repoSegment}/${releaseId}/${assetName}`;
}

/** Resolve an asset storage key to an absolute path, guarding against traversal. */
export function assetPathFromKey(key: string): string {
  const root = path.resolve(assetsRoot());
  const full = path.resolve(root, key);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid asset storage key path");
  }
  return full;
}

/** Stream asset bytes to disk. Returns the number of bytes written. */
export async function writeAssetStream(key: string, source: Readable): Promise<number> {
  const full = assetPathFromKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await pipeline(source, createWriteStream(full));
  const st = await stat(full);
  return st.size;
}

/** Open a readable stream over a stored asset. */
export function readAssetStream(key: string): ReadStream {
  return createReadStream(assetPathFromKey(key));
}

/** Delete a stored asset (idempotent — missing files are ignored). */
export async function removeAsset(key: string): Promise<void> {
  await rm(assetPathFromKey(key), { force: true });
}

// ─── CI (Actions) storage (issue #86) ────────────────────────────────────────
//
// Workflow-run logs and the runner's throwaway commit clones live under a sibling
// of the git storage root (`<root>-ci`), never inside the bare repos — the same
// separation the release assets use. Logs are keyed by
// `<storageKey>/<runId>/<jobId>.log`; the runner clones each job into a temp
// workspace under `<root>-ci/.work/` and deletes it when the job finishes.

function ciRoot(): string {
  return `${path.resolve(storageRoot())}-ci`;
}

/** Resolve a path under the CI root, guarding against traversal. */
function ciPathFromKey(key: string): string {
  const root = path.resolve(ciRoot());
  const full = path.resolve(root, key);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid CI storage key path");
  }
  return full;
}

/** Absolute path to a job's log file: `<root>-ci/<storageKey>/<runId>/<jobId>.log`. */
export function ciLogPath(storageKey: string, runId: string, jobId: string): string {
  return ciPathFromKey(path.join(storageKey, runId, `${jobId}.log`));
}

/** Directory holding one run's logs: `<root>-ci/<storageKey>/<runId>`. */
export function ciRunDir(storageKey: string, runId: string): string {
  return ciPathFromKey(path.join(storageKey, runId));
}

/** Throwaway per-job clone workspace: `<root>-ci/.work/<runId>-<jobId>`. */
export function ciWorkspaceDir(runId: string, jobId: string): string {
  return ciPathFromKey(path.join(".work", `${runId}-${jobId}`));
}

/** Ensure a directory exists (used before writing a log / cloning a workspace). */
export async function ensureCiDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Remove a CI workspace clone (idempotent). */
export async function removeCiWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function buildStorageKey(ownerHandle: string, repoName: string): string {
  return `${ownerHandle}/${repoName}.git`;
}

export function bareRepoPathFromKey(key: string): string {
  const root = path.resolve(storageRoot());
  const full = path.resolve(root, key);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid storage key path");
  }
  return full;
}

export async function createBareRepo(storageKey: string): Promise<string> {
  const fullPath = bareRepoPathFromKey(storageKey);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await execFile("git", ["init", "--bare", "--initial-branch=main", fullPath]);
  // Install the branch-protection pre-receive hook (issue #85). No rules file is
  // written yet, so the hook is inert until a branch is protected.
  await installPreReceiveHook(fullPath);
  return fullPath;
}

export async function removeBareRepo(storageKey: string): Promise<void> {
  const fullPath = bareRepoPathFromKey(storageKey);
  await rm(fullPath, { recursive: true, force: true });
}

export async function moveBareRepo(oldStorageKey: string, newStorageKey: string): Promise<void> {
  const oldPath = bareRepoPathFromKey(oldStorageKey);
  const newPath = bareRepoPathFromKey(newStorageKey);
  await mkdir(path.dirname(newPath), { recursive: true });
  await rename(oldPath, newPath);
}

export type BareRepoInspection = {
  storageKey: string;
  absolutePath: string;
  exists: boolean;
  isBare: boolean;
};

export async function inspectBareRepo(storageKey: string): Promise<BareRepoInspection> {
  const absolutePath = bareRepoPathFromKey(storageKey);

  try {
    await access(absolutePath);
  } catch {
    return {
      storageKey,
      absolutePath,
      exists: false,
      isBare: false,
    };
  }

  try {
    const { stdout } = await execFile("git", ["--git-dir", absolutePath, "rev-parse", "--is-bare-repository"]);
    const isBare = stdout.trim() === "true";
    return {
      storageKey,
      absolutePath,
      exists: true,
      isBare,
    };
  } catch {
    return {
      storageKey,
      absolutePath,
      exists: true,
      isBare: false,
    };
  }
}
