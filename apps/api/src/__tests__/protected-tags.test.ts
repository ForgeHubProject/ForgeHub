import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { writeProtectedTagsConfig } from "../git-hooks.js";
import { isTagProtected, tagMatchesPattern } from "../protected-tags.js";

const execFile = promisify(execFileCb);

// ─── glob matching (pure) ──────────────────────────────────────────────────────

describe("protected-tag glob matching", () => {
  it("matches an exact tag", () => {
    expect(tagMatchesPattern("v1.0.0", "v1.0.0")).toBe(true);
    expect(tagMatchesPattern("v1.0.0", "v1.0.1")).toBe(false);
  });

  it("matches a `*` wildcard within a segment", () => {
    expect(tagMatchesPattern("v*", "v1.2.3")).toBe(true);
    expect(tagMatchesPattern("v*", "release-1")).toBe(false);
    expect(tagMatchesPattern("release-*", "release-2024")).toBe(true);
  });

  it("treats regex metacharacters literally", () => {
    expect(tagMatchesPattern("v1.0", "v1x0")).toBe(false); // '.' is literal, not "any char"
    expect(tagMatchesPattern("v1.0", "v1.0")).toBe(true);
  });

  it("isTagProtected is true when any pattern matches", () => {
    expect(isTagProtected(["release-*", "v*"], "v2.0")).toBe(true);
    expect(isTagProtected(["release-*", "stable"], "v2.0")).toBe(false);
    expect(isTagProtected([], "v2.0")).toBe(false);
  });
});

// ─── API enforcement (real git + mocked prisma) ────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    protectedTag: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { listTags } from "../git-utils.js";
import type { FastifyInstance } from "fastify";

const OWNER = "user-1";
const MOCK_REPO = {
  id: "repo-1",
  name: "my-repo",
  ownerId: OWNER,
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
};

describe("DELETE /repos/:h/:r/tags/:tag protected-tag enforcement", () => {
  let repo: TestRepo;
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    repo = await createTestRepo("test/prot-tags.git");
    await makeCommit(repo.workDir, { "a.txt": "1" }, "init");
    // Push two tags to operate on.
    await execFile("git", ["-C", repo.workDir, "tag", "v1.0.0"]);
    await execFile("git", ["-C", repo.workDir, "tag", "beta-1"]);
    await execFile("git", ["-C", repo.workDir, "push", "origin", "--tags"]);
    (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
    app = await createTestServer();
    auth = await authHeader(app, OWNER);
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
    vi.mocked(prisma.protectedTag.findMany).mockResolvedValue([] as never);
  });

  it("403s when deleting a tag that matches a protected pattern (tag survives)", async () => {
    vi.mocked(prisma.protectedTag.findMany).mockResolvedValue([{ pattern: "v*" }] as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/tags/v1.0.0",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/protected/i);
    const tags = await listTags(repo.storageKey);
    expect(tags.some((t) => t.name === "v1.0.0")).toBe(true);
  });

  it("allows deleting a tag that matches no protected pattern", async () => {
    vi.mocked(prisma.protectedTag.findMany).mockResolvedValue([{ pattern: "v*" }] as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/tags/beta-1",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(204);
    const tags = await listTags(repo.storageKey);
    expect(tags.some((t) => t.name === "beta-1")).toBe(false);
  });

  it("409s when overwriting an existing protected tag via POST", async () => {
    vi.mocked(prisma.protectedTag.findMany).mockResolvedValue([{ pattern: "v*" }] as never);
    const head = (await execFile("git", ["-C", repo.bareRepoPath, "rev-parse", "HEAD"])).stdout.trim();
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/tags",
      headers: { authorization: auth },
      payload: { tag: "v1.0.0", sha: head },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/protected/i);
  });
});

// ─── pre-receive hook enforcement (real git push) ──────────────────────────────

/** Push a refspec to origin, resolving {ok, stderr}. */
async function tryPush(workDir: string, refspec: string, opts: { force?: boolean } = {}) {
  const args = ["-C", workDir, "push", ...(opts.force ? ["--force"] : []), "origin", refspec];
  try {
    const { stderr } = await execFile("git", args);
    return { ok: true, stderr };
  } catch (err) {
    return { ok: false, stderr: (err as { stderr?: string }).stderr ?? String(err) };
  }
}

describe("protected-tag pre-receive hook (real git)", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("prot/tags-hook.git");
    await makeCommit(repo.workDir, { "README.md": "# hi\n" }, "init", "main");
    // Seed a couple of tags on the remote (no rules yet → allowed).
    await execFile("git", ["-C", repo.workDir, "tag", "v1.0.0"]);
    await execFile("git", ["-C", repo.workDir, "tag", "nightly"]);
    await execFile("git", ["-C", repo.workDir, "push", "origin", "--tags"]);
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); });

  it("rejects deletion of a protected tag with a clear message", async () => {
    await writeProtectedTagsConfig(repo.bareRepoPath, ["v*"]);
    const res = await tryPush(repo.workDir, ":refs/tags/v1.0.0");
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/protected tag/i);
    expect(res.stderr).toMatch(/cannot be deleted/i);
  });

  it("rejects a force-move (overwrite) of a protected tag", async () => {
    await writeProtectedTagsConfig(repo.bareRepoPath, ["v*"]);
    // Move v1.0.0 to a new commit locally, then force-push it.
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "move target"]);
    await execFile("git", ["-C", repo.workDir, "tag", "-f", "v1.0.0"]);
    const res = await tryPush(repo.workDir, "refs/tags/v1.0.0", { force: true });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/moved or overwritten/i);
  });

  it("allows deleting a tag that matches no protected pattern", async () => {
    await writeProtectedTagsConfig(repo.bareRepoPath, ["v*"]);
    const res = await tryPush(repo.workDir, ":refs/tags/nightly");
    expect(res.ok).toBe(true);
  });

  it("allows creating a brand-new matching tag (releases keep working)", async () => {
    await writeProtectedTagsConfig(repo.bareRepoPath, ["v*"]);
    await execFile("git", ["-C", repo.workDir, "tag", "v2.0.0"]);
    const res = await tryPush(repo.workDir, "refs/tags/v2.0.0");
    expect(res.ok).toBe(true);
  });

  it("allows all tag operations when the rules file is removed", async () => {
    await writeProtectedTagsConfig(repo.bareRepoPath, []); // clear
    const res = await tryPush(repo.workDir, ":refs/tags/v2.0.0");
    expect(res.ok).toBe(true);
  });
});
