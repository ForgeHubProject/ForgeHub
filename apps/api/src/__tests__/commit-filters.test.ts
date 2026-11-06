/**
 * The Commits page's filters (#256) against a real repo: by author, by date,
 * and that odd input is dropped rather than handed to git.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestRepo, type TestRepo } from "./helpers/git.js";
import { commitFilterArgs, listCommits } from "../git-utils.js";

const execFile = promisify(execFileCb);
let repo: TestRepo;

async function commitAs(name: string, email: string, date: string, file: string) {
  await mkdir(repo.workDir, { recursive: true });
  await writeFile(join(repo.workDir, file), `${name} ${date}\n`);
  await execFile("git", ["-C", repo.workDir, "add", "-A"]);
  await execFile("git", ["-C", repo.workDir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", `${name} on ${date}`], {
    env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` },
  });
}

beforeAll(async () => {
  repo = await createTestRepo("filters/repo.git");
  await commitAs("Ada Lovelace", "ada@example.com", "2026-10-01", "a.txt");
  await commitAs("Grace Hopper", "grace@example.com", "2026-10-15", "b.txt");
  await commitAs("Ada Lovelace", "ada@example.com", "2026-11-01", "c.txt");
  await execFile("git", ["-C", repo.workDir, "push", "origin", "HEAD"]);
}, 30_000);
afterAll(async () => { await repo.cleanup(); });

const subjects = async (o: Parameters<typeof listCommits>[2]) =>
  (await listCommits(repo.storageKey, "main", o)).map((c) => c.subject);

describe("listCommits filters", () => {
  it("filters by author name or email, case-insensitively", async () => {
    expect(await subjects({ author: "ada" })).toEqual(["Ada Lovelace on 2026-11-01", "Ada Lovelace on 2026-10-01"]);
    expect(await subjects({ author: "grace@example.com" })).toEqual(["Grace Hopper on 2026-10-15"]);
  });

  it("filters by an inclusive date range", async () => {
    expect(await subjects({ since: "2026-10-15", until: "2026-10-31" })).toEqual(["Grace Hopper on 2026-10-15"]);
    expect(await subjects({ until: "2026-10-01" })).toEqual(["Ada Lovelace on 2026-10-01"]);
  });

  it("combines with a path", async () => {
    expect(await subjects({ author: "ada", path: "c.txt" })).toEqual(["Ada Lovelace on 2026-11-01"]);
  });
});

describe("commitFilterArgs", () => {
  it("treats the author as text, not a pattern", () => {
    expect(commitFilterArgs({ author: "a.*" })).toEqual(["--fixed-strings", "--regexp-ignore-case", "--author=a.*"]);
  });

  it("drops dates that aren't YYYY-MM-DD and empty authors", () => {
    expect(commitFilterArgs({ author: "  ", since: "yesterday", until: "--all" })).toEqual([]);
  });
});
