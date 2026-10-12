import { spawn } from "node:child_process";
import { bareRepoPathFromKey } from "./git-storage.js";
import { defaultBranch, resolveRefSha } from "./git-utils.js";

/** Every file path at a ref, for the file page's "Go to file" (#223). */
export type RepoPaths = {
  ref: string;
  sha: string;
  paths: string[];
  /** True when the repo has more than MAX_PATHS files and the list stops there. */
  truncated: boolean;
};

/**
 * Past this many files the list stops (and says so): Go to file must answer
 * quickly in any repo, and no one scrolls a hundred thousand matches.
 */
export const MAX_PATHS = 100_000;

const cache = new Map<string, RepoPaths>();
const CACHE_LIMIT = 200;

export function __resetRepoPathsCache(): void {
  cache.clear();
}

/**
 * `git ls-tree -r -z --name-only <commit>`, read as a stream and stopped at
 * `limit` paths, so a huge tree never has to fit one buffer.
 */
function lsTreePaths(storageKey: string, sha: string, limit: number): Promise<{ paths: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-tree", "-r", "-z", "--name-only", sha], { cwd: bareRepoPathFromKey(storageKey) });
    const paths: string[] = [];
    let rest = "";
    let truncated = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const parts = (rest + chunk).split("\0");
      rest = parts.pop() ?? "";
      for (const p of parts) {
        if (!p) continue;
        if (paths.length === limit) {
          truncated = true;
          child.kill();
          return;
        }
        paths.push(p);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (truncated) return resolve({ paths, truncated: true });
      if (code !== 0) return reject(new Error(`git ls-tree exited with ${code}`));
      if (rest) paths.push(rest);
      resolve({ paths: paths.slice(0, limit), truncated: paths.length > limit });
    });
  });
}

/**
 * The paths of every file at `ref` (the default branch when omitted), or null
 * when the ref does not resolve. Cached per commit, which never changes.
 */
export async function listPathsAtRef(storageKey: string, ref?: string, limit = MAX_PATHS): Promise<RepoPaths | null> {
  const name = ref ?? (await defaultBranch(storageKey));
  if (!name || name.startsWith("-")) return null;
  const sha = await resolveRefSha(storageKey, name);
  if (!sha) return null;

  const key = `${storageKey}@${sha}#${limit}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, ref: name };

  const { paths, truncated } = await lsTreePaths(storageKey, sha, limit);
  const result: RepoPaths = { ref: name, sha, paths, truncated };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}
