/**
 * Where `safe.bareRepository` is `explicit`, git refuses to find a bare
 * repository from the working directory: ForgeHub names its own outright, and
 * leaves a merge's temporary work tree to be found as usual.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitDirArgs } from "../git-storage.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fh-git-dir-"));
  await mkdir(path.join(root, "bare.git"));
  await mkdir(path.join(root, "work", ".git"), { recursive: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gitDirArgs", () => {
  it("names a bare repository and leaves a work tree alone", () => {
    expect(gitDirArgs(path.join(root, "bare.git"))).toEqual(["--git-dir", path.join(root, "bare.git")]);
    expect(gitDirArgs(path.join(root, "work"))).toEqual([]);
  });
});
