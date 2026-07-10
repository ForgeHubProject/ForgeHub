import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const MAX = 10 * 1024 * 1024;

// Current location first (forge moved per-repo files into .forge/ — see
// forge#22), then the legacy root-level name still found in older repos.
export const FORGE_FORMATS_PATHS = [".forge/formats", ".forge-formats"] as const;

export function parseForgeFormats(raw: string): Set<string> {
  const result = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    result.add(trimmed.startsWith(".") ? trimmed.toLowerCase() : "." + trimmed.toLowerCase());
  }
  return result;
}

// Reads the repo's opt-in extension list at a commit-ish. Works on bare and
// non-bare repos. Absent file (either location) → empty set: the repo has not
// opted in to any semantic handling.
export async function loadActiveFormats(gitDir: string, commitIsh: string): Promise<Set<string>> {
  for (const path of FORGE_FORMATS_PATHS) {
    try {
      const { stdout } = await execFile("git", ["show", `${commitIsh}:${path}`], {
        cwd: gitDir,
        maxBuffer: MAX,
      });
      return parseForgeFormats(stdout);
    } catch {
      // not present at this location — try the next one
    }
  }
  return new Set();
}
