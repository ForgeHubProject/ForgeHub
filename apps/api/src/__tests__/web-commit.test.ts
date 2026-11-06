/**
 * Web commits (#254) against real bare repos: what the tree holds after each
 * kind of change, and the refusals that keep a concurrent push safe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { cleanPath, commitChanges } from "../web-commit.js";

const execFile = promisify(execFileCb);
const AUTHOR = { name: "Web Editor", email: "web@forgehub.io" };

let repo: TestRepo;
let tip: string;

async function bare(args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: repo.bareRepoPath, maxBuffer: 1 << 24, encoding: "buffer" });
  return stdout.toString("utf8").trim();
}
const files = (ref: string) => bare(["ls-tree", "-r", "--name-only", ref]).then((s) => s.split("\n").filter(Boolean));
const show = (ref: string, p: string) => bare(["show", `${ref}:${p}`]);

beforeEach(async () => {
  repo = await createTestRepo("web/commit.git");
  tip = await makeCommit(repo.workDir, { "README.md": "# Hello\n", "docs/a.md": "a\n", "docs/b.md": "b\n" }, "init");
}, 30_000);

afterEach(async () => {
  await repo.cleanup();
});

describe("commitChanges", () => {
  it("edits a file on the branch, authored as the editor, on top of the tip", async () => {
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", expectedSha: tip, message: "Update README.md",
      changes: [{ path: "README.md", content: Buffer.from("# Hello, world\n") }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parent).toBe(tip);
    expect(await bare(["rev-parse", "main"])).toBe(r.sha);
    expect(await show("main", "README.md")).toBe("# Hello, world");
    expect(await bare(["log", "-1", "--format=%an <%ae>|%s", "main"])).toBe("Web Editor <web@forgehub.io>|Update README.md");
  });

  it("accepts the tip abbreviated, as the branch list gives it", async () => {
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", expectedSha: tip.slice(0, 7), message: "short",
      changes: [{ path: "short.txt", content: Buffer.from("x\n") }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
  });

  it("creates files in new folders and keeps bytes exact", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", message: "Add assets",
      changes: [{ path: "assets/img/logo.png", content: png }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
    const { stdout } = await execFile("git", ["show", "main:assets/img/logo.png"], { cwd: repo.bareRepoPath, encoding: "buffer" });
    expect(Buffer.compare(stdout, png)).toBe(0);
  });

  it("deletes a folder with everything in it", async () => {
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", message: "Remove docs", changes: [{ path: "docs", delete: true }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
    expect(await files("main")).toEqual(["README.md"]);
  });

  it("moves a file, keeping its content unless new content is given", async () => {
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", message: "Move a",
      changes: [{ path: "guide/a.md", from: "docs/a.md" }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
    expect(await files("main")).toEqual(["README.md", "docs/b.md", "guide/a.md"]);
    expect(await show("main", "guide/a.md")).toBe("a");
  });

  it("commits to a new branch, leaving the base where it was", async () => {
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "web-patch-1", expectedSha: tip, message: "Propose",
      changes: [{ path: "README.md", content: Buffer.from("proposal\n") }], author: AUTHOR,
    });
    expect(r.ok).toBe(true);
    expect(await bare(["rev-parse", "main"])).toBe(tip);
    expect(await show("web-patch-1", "README.md")).toBe("proposal");
  });

  it("refuses when the branch moved since the editor read it", async () => {
    const newer = await makeCommit(repo.workDir, { "README.md": "# Newer\n" }, "someone else");
    const r = await commitChanges(repo.storageKey, {
      base: "main", target: "main", expectedSha: tip, message: "stale",
      changes: [{ path: "README.md", content: Buffer.from("mine\n") }], author: AUTHOR,
    });
    expect(r).toEqual({ ok: false, reason: "moved" });
    expect(await bare(["rev-parse", "main"])).toBe(newer);
  });

  it("refuses an existing branch name, a missing file, and a change that changes nothing", async () => {
    await execFile("git", ["branch", "taken", "main"], { cwd: repo.bareRepoPath });
    const taken = await commitChanges(repo.storageKey, {
      base: "main", target: "taken", message: "x", changes: [{ path: "x", content: Buffer.from("x") }], author: AUTHOR,
    });
    expect(taken).toMatchObject({ ok: false, reason: "exists" });

    const missing = await commitChanges(repo.storageKey, {
      base: "main", target: "main", message: "x", changes: [{ path: "nope.md", delete: true }], author: AUTHOR,
    });
    expect(missing).toMatchObject({ ok: false, reason: "missing" });

    const same = await commitChanges(repo.storageKey, {
      base: "main", target: "main", message: "x", changes: [{ path: "README.md", content: Buffer.from("# Hello\n") }], author: AUTHOR,
    });
    expect(same).toEqual({ ok: false, reason: "unchanged" });
  });

  it("refuses paths that leave the repo or touch .git", async () => {
    for (const p of ["../escape", ".git/config", "a//b", "/", "a/./b"]) {
      const r = await commitChanges(repo.storageKey, {
        base: "main", target: "main", message: "x", changes: [{ path: p, content: Buffer.from("x") }], author: AUTHOR,
      });
      expect(r).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
});

describe("cleanPath", () => {
  it("trims slashes and normalizes backslashes", () => {
    expect(cleanPath("/docs/a.md/")).toBe("docs/a.md");
    expect(cleanPath("docs\\a.md")).toBe("docs/a.md");
    expect(cleanPath("  x.txt ")).toBe("x.txt");
  });
});
