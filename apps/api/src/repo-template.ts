import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { bareRepoPathFromKey } from "./git-storage.js";

const execFile = promisify(execFileCb);

/**
 * Start a repository from a template (#256), as GitHub's "Use this template":
 * one "Initial commit" holding the template's default-branch files, with none
 * of its history. Returns the branch it made, or null for an empty template.
 */
export async function seedFromTemplate(
  newStorageKey: string,
  templateStorageKey: string,
  author: { name: string; email: string },
): Promise<string | null> {
  const repo = bareRepoPathFromKey(newStorageKey);
  const template = bareRepoPathFromKey(templateStorageKey);
  const git = (args: string[], env?: Record<string, string>) =>
    execFile("git", args, { cwd: repo, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

  let branch: string;
  try {
    branch = (await execFile("git", ["symbolic-ref", "--short", "HEAD"], { cwd: template })).stdout.trim();
    await execFile("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: template });
  } catch {
    return null; // nothing committed yet
  }
  await git(["fetch", "--no-tags", "--quiet", template, `refs/heads/${branch}:refs/fh-template`]);
  const tree = await git(["rev-parse", "refs/fh-template^{tree}"]);
  const identity = {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  };
  const commit = await git(["commit-tree", tree, "-m", "Initial commit"], identity);
  await git(["update-ref", `refs/heads/${branch}`, commit]);
  await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  await git(["update-ref", "-d", "refs/fh-template"]);
  // Drop the template's history the fetch brought along.
  await git(["reflog", "expire", "--expire=now", "--all"]);
  await git(["gc", "--prune=now", "--quiet"]);
  return branch;
}
