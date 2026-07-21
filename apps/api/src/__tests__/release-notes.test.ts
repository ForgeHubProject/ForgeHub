import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// prisma is mocked; git-utils + git-storage are REAL so notes run against a real repo.
vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    release: { findFirst: vi.fn() },
    releaseAsset: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequest: { findMany: vi.fn() },
  },
}));
vi.mock("../notifications-service.js", () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../prisma.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTag } from "../git-utils.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const execFile = promisify(execFileCb);

const MOCK_REPO = {
  id: "repo-1",
  name: "my-repo",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "acme/notes.git",
  collaborators: [],
};

let app: FastifyInstance;
let repo: TestRepo;
let ownerToken: string;
let mergeSha: string;

beforeAll(async () => {
  repo = await createTestRepo("acme/notes.git");
  const wd = repo.workDir;

  await makeCommit(wd, { "README.md": "hello" }, "init");
  const sha1 = await makeCommit(wd, { "a.txt": "A" }, "add feature A");
  await createTag(repo.storageKey, "v0.1.0", sha1);

  await makeCommit(wd, { "b.txt": "B" }, "fix bug B");

  // A merged-PR-style history: branch, commit, merge with a "(#1)" subject.
  await execFile("git", ["-C", wd, "checkout", "-b", "feature"]);
  await writeFile(join(wd, "feat.txt"), "feature work", "utf8");
  await execFile("git", ["-C", wd, "add", "-A"]);
  await execFile("git", ["-C", wd, "commit", "-m", "implement the thing"]);
  await execFile("git", ["-C", wd, "checkout", "main"]);
  await execFile("git", ["-C", wd, "merge", "--no-ff", "-m", "Merge feature (#1)", "feature"]);
  const { stdout } = await execFile("git", ["-C", wd, "rev-parse", "HEAD"]);
  mergeSha = stdout.trim();
  await execFile("git", ["-C", wd, "push", "origin", "main"]);
  await createTag(repo.storageKey, "v1.0.0", mergeSha);

  app = await createTestServer();
  ownerToken = await authHeader(app, "user-1");
}, 40_000);

afterAll(async () => {
  await app.close();
  await repo.cleanup();
});

function setupRepo() {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
}

describe("POST /releases/generate-notes", () => {
  it("renders PR titles + commit subjects between the previous tag and target", async () => {
    setupRepo();
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { number: 1, title: "Add the feature", author: { handle: "bob" } },
    ] as never);

    const res = await app.inject({
      method: "POST",
      url: "/repos/acme/my-repo/releases/generate-notes",
      headers: { authorization: ownerToken },
      payload: { tagName: "v1.0.0" },
    });
    expect(res.statusCode).toBe(200);
    const { body, previousTag } = res.json();
    expect(previousTag).toBe("v0.1.0");
    expect(body).toContain("## What's changed");
    // merged PR detected from the "(#1)" merge subject
    expect(body).toContain("- Add the feature (!1 by @bob)");
    // plain commit subjects for non-PR commits
    expect(body).toContain("- fix bug B");
    expect(body).toContain("- implement the thing");
    // the merge commit subject itself is not emitted as a raw line
    expect(body).not.toContain("- Merge feature (#1)");
    expect(body).toContain("**Full changelog**: `v0.1.0...v1.0.0`");
  });

  it("falls back to full history from the root when there is no previous tag", async () => {
    setupRepo();
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/acme/my-repo/releases/generate-notes",
      headers: { authorization: ownerToken },
      payload: { tagName: "v0.1.0" },
    });
    expect(res.statusCode).toBe(200);
    const { body, previousTag } = res.json();
    expect(previousTag).toBeNull();
    expect(body).toContain("- add feature A");
    expect(body).toContain("- init");
    expect(body).toContain("**Full changelog**: `v0.1.0`");
  });

  it("returns 400 when tagName is missing", async () => {
    setupRepo();
    const res = await app.inject({
      method: "POST",
      url: "/repos/acme/my-repo/releases/generate-notes",
      headers: { authorization: ownerToken },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for a non-writer", async () => {
    setupRepo();
    const res = await app.inject({
      method: "POST",
      url: "/repos/acme/my-repo/releases/generate-notes",
      headers: { authorization: await authHeader(app, "outsider") },
      payload: { tagName: "v1.0.0" },
    });
    expect(res.statusCode).toBe(403);
  });
});
