/**
 * PR merges hand every format with an FHR handler that merges to that
 * handler — never to git's line merge (#74's division of concerns: FHR owns a
 * format's merge like it owns its diff).
 *
 * The line merge is the dangerous part for text formats. OBJ faces address
 * vertices by position, so a line merge of two edits can be reported clean
 * while a face ends up pointing at another object's vertex. Every fixture here
 * is therefore built so that git WOULD merge it cleanly as text — the edits
 * are far apart — and the tests assert the handler was asked anyway.
 *
 * The handler is a stand-in registered for the official `obj` build, so no
 * wasm release is fetched; the real build's merge is covered in FHR.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createTestRepo, makeCommit, checkoutBranch, type TestRepo } from "./helpers/git.js";
import {
  caseInsensitiveGlob,
  defaultBranch,
  performMerge,
  performMergeWithResolvedFiles,
  performRebaseMerge,
  performSquashMerge,
  readFileAtBranchExact,
} from "../git-utils.js";
import { __resetOfficialHandlers, __setOfficialHandlerForTests } from "../fhr/official-handlers.js";
import { __resetManifest, __setManifestForTests } from "../fhr/manifest.js";
import type { WasmHandler } from "../fhr/wasm-runtime.js";

const execFile = promisify(execFileCb);

const MANIFEST = `
[formats]
".obj" = { handler = "obj", build = "t" }

[assets.handlers."obj"]
"wasm" = "https://example.test/fhr/forge-handler-obj.wasm"
`;

const AUTHOR = { name: "Merl Merger", email: "merl@forgehub.io" };
const MERGED = "# merged by the obj handler\n";

type Call = { base: string; ours: string; theirs: string };

/** A stand-in obj handler: records what it was asked to merge. */
function standIn(opts: { conflicts?: boolean; semanticMerge?: boolean } = {}) {
  const calls: Call[] = [];
  const handler: WasmHandler = {
    diff: async () => ({ version: "1.0", format: "obj", changes: [] }),
    semanticMerge: opts.semanticMerge ?? true,
    merge: async (base, ours, theirs) => {
      calls.push({ base: base.toString(), ours: ours.toString(), theirs: theirs.toString() });
      return {
        blob: Buffer.from(MERGED),
        conflicts: opts.conflicts ? [{ path: "nodes/A", ours: "3 faces", theirs: "removed" }] : [],
      };
    },
  };
  __setOfficialHandlerForTests("obj", handler);
  return calls;
}

// Twenty vertex lines: an edit at the top and one at the bottom never touch,
// so git's line merge would call the pair clean.
const base = Array.from({ length: 20 }, (_, i) => `v ${i} 0 0`).join("\n") + "\n";
const top = base.replace("v 1 0 0", "v 1 5 0");
const bottom = base.replace("v 18 0 0", "v 18 5 0");

let repo: TestRepo;
let def: string;

/**
 * main and feature both edit `file` (feature at the top, main at the bottom),
 * with .forge/formats listing `formats`.
 */
async function divergedRepo(file: string, formats = ".obj\n"): Promise<void> {
  repo = await createTestRepo(`merge/handler-${Math.random().toString(36).slice(2)}.git`);
  await makeCommit(repo.workDir, { ".forge/formats": formats, [file]: base }, "base");
  def = await defaultBranch(repo.storageKey);
  await checkoutBranch(repo.workDir, "feature");
  await makeCommit(repo.workDir, { [file]: top }, "feature edits the top");
  await execFile("git", ["-C", repo.workDir, "checkout", def]);
  await makeCommit(repo.workDir, { [file]: bottom }, "main edits the bottom");
  await execFile("git", ["-C", repo.workDir, "push", "origin", `${def}`, "feature"]);
}

beforeEach(() => {
  __resetOfficialHandlers();
  __setManifestForTests(MANIFEST);
});
afterEach(async () => {
  __resetManifest();
  __resetOfficialHandlers();
  await repo?.cleanup();
});

describe("PR merges hand handler formats to the FHR handler", () => {
  it("merges with the handler even where git's line merge would be clean", async () => {
    const calls = standIn();
    await divergedRepo("model.obj");

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ base, ours: bottom, theirs: top }]);
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(MERGED);
  }, 30_000);

  it("leaves the merge conflicted when the handler reports conflicts, and pushes nothing", async () => {
    standIn({ conflicts: true });
    await divergedRepo("model.obj");

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result).toMatchObject({ ok: false, conflicts: true });
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(bottom);
  }, 30_000);

  it("does not ask the handler about a file only one side changed", async () => {
    const calls = standIn();
    repo = await createTestRepo("merge/handler-one-sided.git");
    await makeCommit(repo.workDir, { ".forge/formats": ".obj\n", "model.obj": base }, "base");
    def = await defaultBranch(repo.storageKey);
    await checkoutBranch(repo.workDir, "feature");
    await makeCommit(repo.workDir, { "model.obj": top }, "feature edits");
    await execFile("git", ["-C", repo.workDir, "checkout", def]);
    await makeCommit(repo.workDir, { "notes.txt": "unrelated\n" }, "main edits elsewhere");
    await execFile("git", ["-C", repo.workDir, "push", "origin", def, "feature"]);

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(top);
  }, 30_000);

  it("matches the extension case-insensitively, as handlers do", async () => {
    const calls = standIn();
    await divergedRepo("MODEL.OBJ");

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  }, 30_000);

  it("squash-merges through the handler too", async () => {
    const calls = standIn();
    await divergedRepo("model.obj");

    const result = await performSquashMerge(repo.storageKey, "feature", def, "squash feature", AUTHOR);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(MERGED);
  }, 30_000);

  it("stops a rebase-merge as a conflict rather than line-merging the replay", async () => {
    standIn();
    await divergedRepo("model.obj");

    const result = await performRebaseMerge(repo.storageKey, "feature", def);
    expect(result).toMatchObject({ ok: false, conflicts: true });
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(bottom);
  }, 30_000);

  it("merges handler formats the reviewer did not resolve by hand", async () => {
    const calls = standIn();
    await divergedRepo("model.obj");

    const result = await performMergeWithResolvedFiles(repo.storageKey, "feature", def, "resolve", {});
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await readFileAtBranchExact(repo.storageKey, def, "model.obj")).toBe(MERGED);
  }, 30_000);

  it("leaves formats whose handler declares no merge to git, as before", async () => {
    const calls = standIn({ semanticMerge: false });
    await divergedRepo("model.obj");

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    // git's line merge took both edits.
    const merged = await readFileAtBranchExact(repo.storageKey, def, "model.obj");
    expect(merged).toContain("v 1 5 0");
    expect(merged).toContain("v 18 5 0");
  }, 30_000);

  it("leaves a repo that has not opted the format in to git, as before", async () => {
    const calls = standIn();
    await divergedRepo("model.obj", ".glb\n");

    const result = await performMerge(repo.storageKey, "feature", def, "merge feature");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  }, 30_000);
});

describe("caseInsensitiveGlob", () => {
  it("spells each letter both ways and leaves the rest alone", () => {
    expect(caseInsensitiveGlob(".obj")).toBe(".[oO][bB][jJ]");
    expect(caseInsensitiveGlob(".3mf")).toBe(".3[mM][fF]");
  });
});
