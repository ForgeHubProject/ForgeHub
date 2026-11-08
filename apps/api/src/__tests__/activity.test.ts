/**
 * A repository's Activity (#256): how pushes move branches, and the page that
 * lists them.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    repo: { findFirst: vi.fn() },
    refUpdate: { findMany: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { classifyRefUpdates } from "../activity-log.js";
import { authHeader, createTestServer } from "./helpers/server.js";
import { createTestRepo, makeCommit } from "./helpers/git.js";

const execFile = promisify(execFileCb);

describe("classifyRefUpdates", () => {
  let repo: Awaited<ReturnType<typeof createTestRepo>>;
  beforeAll(async () => {
    repo = await createTestRepo("acme/activity.git");
  }, 30_000);
  afterAll(async () => {
    await repo.cleanup();
  });

  it("tells pushes from force pushes, and sees branches made and deleted", async () => {
    const a = await makeCommit(repo.workDir, { "a.txt": "a" }, "a");
    const b = await makeCommit(repo.workDir, { "b.txt": "b" }, "b");
    // A rewrite: back to a, then a different commit on top.
    await execFile("git", ["-C", repo.workDir, "reset", "--hard", a]);
    await execFile("git", ["-C", repo.workDir, "commit", "--allow-empty", "-m", "c"]);
    const c = (await execFile("git", ["-C", repo.workDir, "rev-parse", "HEAD"])).stdout.trim();
    await execFile("git", ["-C", repo.workDir, "push", "--force", "origin", "HEAD:main"]);

    const updates = await classifyRefUpdates(
      repo.bareRepoPath,
      new Map([["main", a], ["old", a], ["topic", b]]),
      new Map([["main", b], ["topic", c], ["new", c]]),
    );
    expect(updates).toEqual([
      { ref: "main", kind: "push", beforeSha: a, afterSha: b },
      { ref: "topic", kind: "force_push", beforeSha: b, afterSha: c },
      { ref: "new", kind: "branch_created", beforeSha: null, afterSha: c },
      { ref: "old", kind: "branch_deleted", beforeSha: a, afterSha: null },
    ]);
  });
});

describe("GET activity", () => {
  const ME = "user-me";
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, ME);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      id: "r1", name: "poster", visibility: "PUBLIC", storageKey: null, ownerId: ME, orgId: null,
      owner: { handle: "ada" }, org: null, collaborators: [], teamAccess: [],
    } as never);
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: token } });

  it("lists branch updates newest first, with who did them, a page at a time", async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 8, 0, m));
    vi.mocked(prisma.refUpdate.findMany).mockResolvedValue(
      Array.from({ length: 31 }, (_, i) => ({
        id: `u${i}`, repoId: "r1", ref: "main", kind: i === 0 ? "merge" : "branch_created", beforeSha: null, afterSha: "abc",
        actorId: "ada-id", prNumber: i === 0 ? 4 : null, createdAt: at(59 - i),
      })) as never,
    );
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "ada-id", handle: "ada", displayName: "Ada", avatarKey: null }] as never);
    const res = (await get("/repos/ada/poster/activity?branch=main")).json();
    expect(res.events).toHaveLength(30);
    expect(res.events[0]).toMatchObject({ kind: "merge", prNumber: 4, actor: { handle: "ada" } });
    expect(res.next).toBe(at(30).toISOString());
    expect(vi.mocked(prisma.refUpdate.findMany).mock.calls[0][0]!.where).toEqual({ repoId: "r1", ref: "main" });
  });

  it("filters by kind and actor, and refuses an unknown kind", async () => {
    vi.mocked(prisma.refUpdate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "ada-id" } as never);
    await get("/repos/ada/poster/activity?kind=force_push&actor=Ada&before=2026-11-08T00:00:00.000Z");
    expect(vi.mocked(prisma.refUpdate.findMany).mock.calls[0][0]!.where).toEqual({
      repoId: "r1", kind: "force_push", actorId: "ada-id", createdAt: { lt: new Date("2026-11-08T00:00:00.000Z") },
    });
    expect((await get("/repos/ada/poster/activity?kind=rename")).statusCode).toBe(400);
  });
});
