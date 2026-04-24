import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const execFile = promisify(execFileCb);

function storageRoot(): string {
  return process.env["GIT_STORAGE_ROOT"]?.trim() || path.resolve(process.cwd(), "git-storage");
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
  await execFile("git", ["init", "--bare", fullPath]);
  return fullPath;
}

export async function removeBareRepo(storageKey: string): Promise<void> {
  const fullPath = bareRepoPathFromKey(storageKey);
  await rm(fullPath, { recursive: true, force: true });
}
