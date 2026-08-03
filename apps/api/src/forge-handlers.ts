import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const MAX = 10 * 1024 * 1024;

// Current location first (forge moved per-repo files into .forge/ — see
// forge#22), then the legacy root-level name still found in older repos.
export const FORGE_HANDLERS_PATHS = [".forge/handlers", ".forge-handlers"] as const;

/**
 * Parse the `.forge/handlers` lockfile: a JSON object mapping handler id →
 * pinned content-hash build, with null for an installed-but-unpinned handler
 * (forge's LoadForgeHandlers shape). Malformed content yields an empty map —
 * a broken lockfile means "no pins", never an error, mirroring how forge and
 * parseForgeFormats treat their files.
 */
export function parseForgeHandlers(raw: string): Map<string, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();

  const pins = new Map<string, string | null>();
  for (const [id, build] of Object.entries(parsed)) {
    if (typeof build === "string") pins.set(id, build);
    else if (build === null) pins.set(id, null);
    // anything else (number, object) is not a valid pin — skipped
  }
  return pins;
}

// Reads the repo's handler-build pins at a commit-ish. Works on bare and
// non-bare repos. Absent file (either location) → empty map: the repo pins
// nothing, so client tiers run whatever build the manifest currently serves.
export async function loadHandlerPins(gitDir: string, commitIsh: string): Promise<Map<string, string | null>> {
  for (const path of FORGE_HANDLERS_PATHS) {
    try {
      const { stdout } = await execFile("git", ["show", `${commitIsh}:${path}`], {
        cwd: gitDir,
        maxBuffer: MAX,
      });
      return parseForgeHandlers(stdout);
    } catch {
      // not present at this location — try the next one
    }
  }
  return new Map();
}
