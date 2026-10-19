/**
 * A pull request's range — the merge base and head its files and commits are
 * between — once it is merged (pull-range.ts). The branches can't say: after a
 * merge the base branch contains the head, so their merge base IS the head and
 * the PR read "0 files changed". Each merge method leaves a different shape.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getMergeBaseFileList } from "../git-utils.js";
import { liveRange, pullRange } from "../pull-range.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";

const run = promisify(execFileCb);

let repo: TestRepo;
let main: string;
const sha = async (ref: string): Promise<string> =>
  (await run("git", ["-C", repo.workDir, "rev-parse", ref])).stdout.trim();
const git = (...args: string[]) => run("git", ["-C", repo.workDir, ...args]);
const files = async (range: { base: string; head: string } | null): Promise<string[]> =>
  range ? (await getMergeBaseFileList(repo.storageKey, range.base, range.head)).map((f) => f.path).sort() : [];

beforeAll(async () => {
  repo = await createTestRepo("test/pull-range.git");
  await makeCommit(repo.workDir, { "a.txt": "a" }, "base");
  main = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
}, 30_000);
afterAll(async () => { await repo.cleanup(); });

describe("pullRange", () => {
  it("reads an open PR live from its branches", async () => {
    const fork = await sha("HEAD");
    await makeCommit(repo.workDir, { "b.txt": "b" }, "b", "feature");
    await makeCommit(repo.workDir, { "c.txt": "c" }, "c", "feature");
    await git("checkout", main);
    await makeCommit(repo.workDir, { "d.txt": "d" }, "d on main");
    const range = await pullRange(repo.storageKey, { state: "OPEN", toBranch: main, fromBranch: "feature" });
    expect(range).toEqual({ base: fork, head: await sha("feature") });
    expect(await files(range)).toEqual(["b.txt", "c.txt"]);
  });

  it("names a merged PR's range from its merge commit's second parent", async () => {
    const head = await sha("feature");
    await git("merge", "--no-ff", "-m", "Merge feature", "feature");
    await git("push", "origin", "HEAD");
    const merge = await sha("HEAD");
    // The bug: the branches now name an empty range.
    expect(await files(await liveRange(repo.storageKey, main, "feature"))).toEqual([]);
    const range = await pullRange(repo.storageKey, {
      state: "MERGED", toBranch: main, fromBranch: "feature", mergeCommitSha: merge, mergeMethod: "merge",
    });
    expect(range?.head).toBe(head);
    expect(await files(range)).toEqual(["b.txt", "c.txt"]);
  });

  it("names a squash as its one commit against its parent", async () => {
    await makeCommit(repo.workDir, { "e.txt": "e" }, "e", "squashed");
    await makeCommit(repo.workDir, { "f.txt": "f" }, "f", "squashed");
    await git("checkout", main);
    await git("merge", "--squash", "squashed");
    await git("commit", "-m", "Squash (!2)");
    await git("push", "origin", "HEAD");
    const squash = await sha("HEAD");
    const range = await pullRange(repo.storageKey, {
      state: "MERGED", toBranch: main, fromBranch: "squashed", mergeCommitSha: squash, mergeMethod: "squash",
    });
    expect(range).toEqual({ base: await sha("HEAD^"), head: squash });
    expect(await files(range)).toEqual(["e.txt", "f.txt"]);
  });

  it("names a rebase by the source branch's commit count", async () => {
    await makeCommit(repo.workDir, { "g.txt": "g" }, "g", "rebased");
    await makeCommit(repo.workDir, { "h.txt": "h" }, "h", "rebased");
    await git("checkout", main);
    await makeCommit(repo.workDir, { "i.txt": "i" }, "i on main");
    const before = await sha("HEAD");
    // Replay the PR onto main and fast-forward, leaving the source branch where
    // it was — what the rebase merge does in its own clone.
    await git("checkout", "-b", "replay", "rebased");
    await git("rebase", main);
    await git("checkout", main);
    await git("merge", "--ff-only", "replay");
    await git("push", "origin", "HEAD");
    const tip = await sha("HEAD");
    const range = await pullRange(repo.storageKey, {
      state: "MERGED", toBranch: main, fromBranch: "rebased", mergeCommitSha: tip, mergeMethod: "rebase",
    });
    expect(range).toEqual({ base: before, head: tip });
    expect(await files(range)).toEqual(["g.txt", "h.txt"]);
  });

  it("prefers the range recorded at merge or close", async () => {
    const base = await sha(`${main}~2`);
    const head = await sha(main);
    const range = await pullRange(repo.storageKey, {
      state: "CLOSED", toBranch: main, fromBranch: "gone", baseSha: base, headSha: head,
    });
    expect(range).toEqual({ base, head });
  });

  it("is null when nothing can name it", async () => {
    expect(await pullRange(repo.storageKey, { state: "CLOSED", toBranch: main, fromBranch: "never-existed" })).toBeNull();
  });
});
