import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import {
  formatsInEffect,
  loadActiveFormats,
  loadListedFormats,
  parseForgeFormats,
  parseIgnoredFormats,
} from "../forge-formats.js";
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

  it("leaves out ignored ('!') lines, which parseIgnoredFormats reads", () => {
    const raw = ".gltf\n!png\n! .PSD\n!\n";
    expect(parseForgeFormats(raw)).toEqual(new Set([".gltf"]));
    expect(parseIgnoredFormats(raw)).toEqual(new Set([".png", ".psd"]));
  });
});

// The forge CLI's reading (forge internal/forgerepo/forgefiles.go): the list is a
// filter, so no list means every handler, and an ignore always wins.
describe("formatsInEffect", () => {
  const official = async () => [".gltf", ".glb", ".png"];

  it("puts every official format in effect when the repo has no formats file", async () => {
    expect(await formatsInEffect(null, official)).toEqual(new Set([".gltf", ".glb", ".png"]));
  });

  it("puts every official format but the ignored ones in effect when the file lists none", async () => {
    const file = { listed: new Set<string>(), ignored: new Set([".png"]) };
    expect(await formatsInEffect(file, official)).toEqual(new Set([".gltf", ".glb"]));
  });

  it("narrows to the listed formats when the file lists any", async () => {
    const file = { listed: new Set([".glb", ".obj"]), ignored: new Set<string>() };
    expect(await formatsInEffect(file, official)).toEqual(new Set([".glb", ".obj"]));
  });

  it("lets an ignore win over a listing", async () => {
    const file = { listed: new Set([".glb", ".png"]), ignored: new Set([".png"]) };
    expect(await formatsInEffect(file, official)).toEqual(new Set([".glb"]));
  });

  it("gives nothing rather than a guess when the official list can't be had", async () => {
    const unreachable = async (): Promise<string[]> => {
      throw new Error("manifest down");
    };
    expect((await formatsInEffect(null, unreachable)).size).toBe(0);
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

  it("puts every official format in effect when no formats file exists", async () => {
    const sha = await makeCommit(repo.workDir, { "readme.txt": "hi" }, "init");
    expect(await loadActiveFormats(repo.bareRepoPath, sha, async () => [".gltf", ".png"])).toEqual(
      new Set([".gltf", ".png"]),
    );
    // Background indexing only follows an explicit list.
    expect((await loadListedFormats(repo.bareRepoPath, sha)).size).toBe(0);
  });

  it("reads an ignore-only file as every official format but the ignored", async () => {
    const sha = await makeCommit(repo.workDir, { ".forge/formats": "!png\n" }, "ignore png");
    expect(await loadActiveFormats(repo.bareRepoPath, sha, async () => [".gltf", ".png"])).toEqual(new Set([".gltf"]));
    expect((await loadListedFormats(repo.bareRepoPath, sha)).size).toBe(0);
    // Back to no file, so the next tests' legacy file is the one read.
    await rm(join(repo.workDir, ".forge/formats"));
    await makeCommit(repo.workDir, { "readme.txt": "bye" }, "drop the formats file");
  });

  it("reads the legacy root-level .forge-formats", async () => {
    const sha = await makeCommit(repo.workDir, { ".forge-formats": ".gltf\n" }, "legacy formats");
    expect(await loadActiveFormats(repo.bareRepoPath, sha)).toEqual(new Set([".gltf"]));
  });

  it("prefers .forge/formats over the legacy file when both exist", async () => {
    const sha = await makeCommit(repo.workDir, { ".forge/formats": ".txt\n" }, "new formats location");
    expect(await loadActiveFormats(repo.bareRepoPath, sha)).toEqual(new Set([".txt"]));
    expect(await loadListedFormats(repo.bareRepoPath, sha)).toEqual(new Set([".txt"]));
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
