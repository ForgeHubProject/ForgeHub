import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStorageKey,
  bareRepoPathFromKey,
  createBareRepo,
  removeBareRepo,
  moveBareRepo,
  inspectBareRepo,
} from "../git-storage.js";

let storageRoot: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  storageRoot = await mkdtemp(join(tmpdir(), "fh-storage-test-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  cleanup = () => rm(storageRoot, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env["GIT_STORAGE_ROOT"];
  await cleanup();
});

describe("buildStorageKey", () => {
  it("formats as handle/repo.git", () => {
    expect(buildStorageKey("alice", "my-repo")).toBe("alice/my-repo.git");
  });

  it("preserves case in handle and repo name", () => {
    expect(buildStorageKey("Alice", "My-Repo")).toBe("Alice/My-Repo.git");
  });
});

describe("bareRepoPathFromKey", () => {
  it("returns an absolute path under the storage root", () => {
    const p = bareRepoPathFromKey("alice/repo.git");
    expect(p).toBe(join(storageRoot, "alice/repo.git"));
  });

  it("throws on path traversal attempt (../ escape)", () => {
    expect(() => bareRepoPathFromKey("../escape/repo.git")).toThrow("Invalid storage key path");
  });

  it("throws on absolute path injection", () => {
    expect(() => bareRepoPathFromKey("/etc/passwd")).toThrow("Invalid storage key path");
  });
});

describe("createBareRepo", () => {
  it("creates a bare git repository at the storage key path", async () => {
    const path = await createBareRepo("alice/test.git");
    const inspection = await inspectBareRepo("alice/test.git");
    expect(inspection.exists).toBe(true);
    expect(inspection.isBare).toBe(true);
    expect(inspection.absolutePath).toBe(path);
  });

  it("returned path matches bareRepoPathFromKey", async () => {
    const returned = await createBareRepo("alice/test.git");
    expect(returned).toBe(bareRepoPathFromKey("alice/test.git"));
  });
});

describe("inspectBareRepo", () => {
  it("returns exists=false for a non-existent storage key", async () => {
    const result = await inspectBareRepo("ghost/repo.git");
    expect(result.exists).toBe(false);
    expect(result.isBare).toBe(false);
  });

  it("returns exists=true and isBare=true for a bare repo", async () => {
    await createBareRepo("alice/real.git");
    const result = await inspectBareRepo("alice/real.git");
    expect(result.exists).toBe(true);
    expect(result.isBare).toBe(true);
  });

  it("includes correct storageKey and absolutePath", async () => {
    await createBareRepo("alice/real.git");
    const result = await inspectBareRepo("alice/real.git");
    expect(result.storageKey).toBe("alice/real.git");
    expect(result.absolutePath).toBe(join(storageRoot, "alice/real.git"));
  });
});

describe("removeBareRepo", () => {
  it("deletes the bare repo directory", async () => {
    await createBareRepo("alice/temp.git");
    await removeBareRepo("alice/temp.git");
    const result = await inspectBareRepo("alice/temp.git");
    expect(result.exists).toBe(false);
  });

  it("does not throw if the repo does not exist (force remove)", async () => {
    await expect(removeBareRepo("alice/ghost.git")).resolves.not.toThrow();
  });
});

describe("moveBareRepo", () => {
  it("moves the repo to the new storage key path", async () => {
    await createBareRepo("alice/before.git");
    await moveBareRepo("alice/before.git", "alice/after.git");

    const before = await inspectBareRepo("alice/before.git");
    const after = await inspectBareRepo("alice/after.git");
    expect(before.exists).toBe(false);
    expect(after.exists).toBe(true);
    expect(after.isBare).toBe(true);
  });
});
