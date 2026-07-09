import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { parseForgeFormats, loadActiveFormats } from "../forge-formats.js";
import { firstHandlerForPathAndFormats } from "../handlers/index.js";
import { GLTF_SCENE_HANDLER_ID, PLAIN_TEXT_HANDLER_ID } from "../handlers/types.js";

describe("parseForgeFormats", () => {
  it("parses one extension per line, ignoring comments and blanks", () => {
    const exts = parseForgeFormats("# 3d assets\n.gltf\n\n.glb\n");
    expect(exts).toEqual(new Set([".gltf", ".glb"]));
  });

  it("normalizes entries missing the leading dot and mixed case", () => {
    const exts = parseForgeFormats("gltf\n.TXT\n");
    expect(exts).toEqual(new Set([".gltf", ".txt"]));
  });

  it("returns an empty set for empty or comment-only input", () => {
    expect(parseForgeFormats("").size).toBe(0);
    expect(parseForgeFormats("# nothing enabled\n").size).toBe(0);
  });
});

describe("loadActiveFormats", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("test/formats.git");
  }, 30_000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it("returns an empty set when no formats file exists", async () => {
    const sha = await makeCommit(repo.workDir, { "readme.txt": "hi" }, "init");
    expect((await loadActiveFormats(repo.bareRepoPath, sha)).size).toBe(0);
  });

  it("reads the legacy root-level .forge-formats", async () => {
    const sha = await makeCommit(repo.workDir, { ".forge-formats": ".gltf\n" }, "legacy formats");
    expect(await loadActiveFormats(repo.bareRepoPath, sha)).toEqual(new Set([".gltf"]));
  });

  it("prefers .forge/formats over the legacy file when both exist", async () => {
    const sha = await makeCommit(repo.workDir, { ".forge/formats": ".txt\n" }, "new formats location");
    expect(await loadActiveFormats(repo.bareRepoPath, sha)).toEqual(new Set([".txt"]));
  });

  it("resolves symbolic refs like HEAD in a work dir", async () => {
    expect(await loadActiveFormats(repo.workDir, "HEAD")).toEqual(new Set([".txt"]));
  });
});

describe("firstHandlerForPathAndFormats", () => {
  it("returns the matching handler when the extension is opted in", () => {
    const handler = firstHandlerForPathAndFormats("scene/model.gltf", new Set([".gltf"]));
    expect(handler?.id).toBe(GLTF_SCENE_HANDLER_ID);
    const text = firstHandlerForPathAndFormats("notes.txt", new Set([".txt"]));
    expect(text?.id).toBe(PLAIN_TEXT_HANDLER_ID);
  });

  it("returns undefined when the extension is not opted in", () => {
    expect(firstHandlerForPathAndFormats("scene/model.gltf", new Set([".txt"]))).toBeUndefined();
  });

  it("returns undefined for an empty set (repo did not opt in)", () => {
    expect(firstHandlerForPathAndFormats("notes.txt", new Set())).toBeUndefined();
  });

  it("is case-insensitive on the file extension", () => {
    const handler = firstHandlerForPathAndFormats("Model.GLTF", new Set([".gltf"]));
    expect(handler?.id).toBe(GLTF_SCENE_HANDLER_ID);
  });
});
