import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { officialFormats } from "./fhr/manifest.js";
import { gitDirArgs } from "./git-storage.js";

const execFile = promisify(execFileCb);
const MAX = 10 * 1024 * 1024;

// Current location first (forge moved per-repo files into .forge/ — see
// forge#22), then the legacy root-level name still found in older repos.
export const FORGE_FORMATS_PATHS = [".forge/formats", ".forge-formats"] as const;

/** One line of a formats file: its extension (dot-prefixed, lower-cased) and whether it is ignored. */
function parseFormatLine(line: string): { ext: string; ignored: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const ignored = trimmed.startsWith("!");
  const name = (ignored ? trimmed.slice(1).trim() : trimmed).toLowerCase();
  if (!name) return null;
  return { ext: name.startsWith(".") ? name : "." + name, ignored };
}

/**
 * The extensions a formats file lists, without the ignored ones: a line
 * starting with '!' is an ignored format (`forge formats ignore`), never an
 * included one.
 */
export function parseForgeFormats(raw: string): Set<string> {
  const result = new Set<string>();
  for (const line of raw.split("\n")) {
    const entry = parseFormatLine(line);
    if (entry && !entry.ignored) result.add(entry.ext);
  }
  return result;
}

/** The extensions a formats file ignores ('!' lines, `forge formats ignore`). */
export function parseIgnoredFormats(raw: string): Set<string> {
  const result = new Set<string>();
  for (const line of raw.split("\n")) {
    const entry = parseFormatLine(line);
    if (entry?.ignored) result.add(entry.ext);
  }
  return result;
}

/** What a repo's formats file says at a commit: what it lists and what it ignores. */
export type FormatsFile = { listed: Set<string>; ignored: Set<string> };

/** The repo's formats file at a commit-ish, or null when it has none (in either location). */
export async function readFormatsFile(gitDir: string, commitIsh: string): Promise<FormatsFile | null> {
  for (const path of FORGE_FORMATS_PATHS) {
    try {
      const { stdout } = await execFile("git", [...gitDirArgs(gitDir), "show", `${commitIsh}:${path}`], {
        cwd: gitDir,
        maxBuffer: MAX,
      });
      return { listed: parseForgeFormats(stdout), ignored: parseIgnoredFormats(stdout) };
    } catch {
      // not present at this location — try the next one
    }
  }
  return null;
}

/** Every extension FHR's manifest has an official handler for. */
async function officialExtensions(): Promise<Iterable<string>> {
  return (await officialFormats()).keys();
}

/**
 * The formats a repo's file puts in effect, read the way the forge CLI reads it
 * (forge internal/forgerepo/forgefiles.go): the list is a filter, so a repo that
 * lists no formats, or has no file at all, gets every official handler, and an
 * ignored format is off whatever else the file says. A repository imported
 * from GitHub, or one that never ran `forge formats add`, has no file, so its
 * files get their semantic diffs like any other (#289).
 *
 * Every official extension comes from FHR's manifest; when it can't be reached,
 * an unlisting repo gets nothing rather than a guess.
 */
export async function formatsInEffect(
  file: FormatsFile | null,
  allFormats: () => Promise<Iterable<string>> = officialExtensions,
): Promise<Set<string>> {
  const ignored = file?.ignored ?? new Set<string>();
  let wanted: Iterable<string>;
  if (file && file.listed.size > 0) {
    wanted = file.listed;
  } else {
    try {
      wanted = await allFormats();
    } catch {
      wanted = [];
    }
  }
  return new Set([...wanted].filter((ext) => !ignored.has(ext)));
}

// The formats in effect at a commit-ish (formatsInEffect). Works on bare and
// non-bare repos.
export async function loadActiveFormats(
  gitDir: string,
  commitIsh: string,
  allFormats?: () => Promise<Iterable<string>>,
): Promise<Set<string>> {
  return formatsInEffect(await readFormatsFile(gitDir, commitIsh), allFormats);
}

/**
 * Only the formats a repo's file explicitly lists, minus the ignored ones; an
 * absent or empty list gives nothing. For work the server does unasked in the
 * background (entity search indexing at push), which reads every version of
 * every such file in the pushed history: a repo asks for that by listing them.
 */
export async function loadListedFormats(gitDir: string, commitIsh: string): Promise<Set<string>> {
  const file = await readFormatsFile(gitDir, commitIsh);
  if (!file) return new Set();
  return new Set([...file.listed].filter((ext) => !file.ignored.has(ext)));
}
