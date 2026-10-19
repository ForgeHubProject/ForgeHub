import { execFile as execFileCb } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { loadActiveFormats } from "./forge-formats.js";
import { officialHandlerId } from "./fhr/official-handlers.js";
import { ingestSceneSnapshot } from "./fhr-entities.js";

const execFile = promisify(execFileCb);

// Walk the commits in oldSha..newSha (or all of them if oldSha is the null SHA)
// and record the scene entities of every opted-in file each commit changed, for
// entity search. The file's official FHR handler reads it (fhr-entities.ts);
// ForgeHub runs no parser of its own (#74).
//
// Only the files a commit changed, against its first parent: a file the commit
// left alone is already recorded at the commit that last changed it, so
// re-reading every file at every commit only duplicated the same entities.
export async function ingestCommitRange(
  repoId: string,
  repoPath: string,
  oldSha: string,
  newSha: string,
): Promise<void> {
  // Only ingest extensions the repo opted into at the tip commit.
  // Absent file → nothing to ingest (explicit opt-in model).
  const activeExts = await loadActiveFormats(repoPath, newSha);
  if (activeExts.size === 0) return;

  const NULL_SHA = "0".repeat(40);
  const revRange = oldSha === NULL_SHA ? newSha : `${oldSha}..${newSha}`;

  const { stdout: logOut } = await execFile(
    "git",
    ["log", "--format=%H|%s", "--reverse", revRange],
    { cwd: repoPath },
  );

  const commits = logOut
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("|");
      return { sha: line.slice(0, idx), message: line.slice(idx + 1).trim() };
    });

  // One manifest lookup per extension for the whole range.
  const official = new Map<string, boolean>();
  const isOfficial = async (ext: string): Promise<boolean> => {
    if (!official.has(ext)) {
      official.set(ext, await officialHandlerId(ext).then((id) => id !== null, () => false));
    }
    return official.get(ext)!;
  };

  for (const commit of commits) {
    const { stdout: changedOut } = await execFile(
      "git",
      // --root: a first commit lists everything it added. --diff-filter=d: a
      // deleted file has nothing left to read.
      ["diff-tree", "--no-commit-id", "-r", "--name-only", "--root", "--diff-merges=first-parent", "--diff-filter=d", commit.sha],
      { cwd: repoPath },
    );
    const paths = changedOut
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    for (const file of paths) {
      const ext = extname(file).toLowerCase();
      if (!activeExts.has(ext) || !(await isOfficial(ext))) continue;
      try {
        // Bytes, not text: a UTF-8 decode would corrupt binary formats (.glb).
        const { stdout: content } = await execFile(
          "git",
          ["show", `${commit.sha}:${file}`],
          { cwd: repoPath, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
        );
        await ingestSceneSnapshot({
          repoId,
          sourceFile: file,
          bytes: content,
          label: commit.message || null,
          gitCommitSha: commit.sha,
          activeExts,
        });
      } catch (e) {
        console.error(`[ingest] skipping ${file}@${commit.sha.slice(0, 7)}: ${String(e)}`);
      }
    }
  }
}
