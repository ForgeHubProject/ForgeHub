import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadActiveFormats } from "./forge-formats.js";
import { firstHandlerForPathAndFormats } from "./handlers/index.js";

const execFile = promisify(execFileCb);

// Walk all commits in oldSha..newSha (or all commits if oldSha is the null SHA)
// and ingest every file path matched by a registered artifact handler.
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

  for (const commit of commits) {
    const { stdout: treeOut } = await execFile(
      "git",
      ["ls-tree", "-r", "--name-only", commit.sha],
      { cwd: repoPath },
    );

    const paths = treeOut
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    for (const file of paths) {
      const handler = firstHandlerForPathAndFormats(file, activeExts);
      if (!handler) continue;

      try {
        const { stdout: content } = await execFile(
          "git",
          ["show", `${commit.sha}:${file}`],
          { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
        );
        await handler.ingestFromUtf8Text({
          repoId,
          sourceFile: file,
          utf8Text: content,
          label: commit.message || null,
          gitCommitSha: commit.sha,
        });
      } catch (e) {
        console.error(`[ingest] skipping ${file}@${commit.sha.slice(0, 7)}: ${String(e)}`);
      }
    }
  }
}
