import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";

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
