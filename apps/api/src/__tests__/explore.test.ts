/**
 * Discovery and activity (#257): Explore's public repositories by format and
 * topic, the format scan behind it, monthly contribution activity, and private
 * profiles.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    repo: { findMany: vi.fn(), count: vi.fn() },
    repoTopic: { groupBy: vi.fn() },
    pullRequest: { findMany: vi.fn() },
    issue: { findMany: vi.fn() },
    pullRequestReview: { findMany: vi.fn() },
    star: { findMany: vi.fn() },
    follow: { findMany: vi.fn(), findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { __resetManifest, __setManifestForTests } from "../fhr/manifest.js";
import { scanRepoFormats } from "../repo-formats.js";
import { authHeader, createTestServer } from "./helpers/server.js";
import { createTestRepo, makeCommit } from "./helpers/git.js";

const ME = "user-me";
const repoRow = (name: string, formats: string[] | null) => ({
  id: name, name, description: null, visibility: "PUBLIC", storageKey: `acme/${name}.git`, ownerId: "acme-id",
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-02-01"), formats: formats && JSON.stringify(formats),
  owner: { handle: "acme" }, org: null, topics: [], _count: { stars: 2 },
});

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
});

describe("Explore", () => {
  it("lists public repositories, filtered by format family and topic", async () => {
    vi.mocked(prisma.repo.findMany)
      .mockResolvedValueOnce([] as never) // nothing left to scan
      .mockResolvedValueOnce([repoRow("poster", ["psd", "png"])] as never);
    vi.mocked(prisma.repo.count).mockResolvedValue(1 as never);
    const res = await app.inject({ method: "GET", url: "/explore/repos?format=psd&topic=Design" });
    expect(res.json()).toMatchObject({ total: 1, hasMore: false, repos: [{ fullName: "acme/poster", formats: ["psd", "png"], starCount: 2 }] });
    const where = vi.mocked(prisma.repo.findMany).mock.calls[1][0]!.where;
    expect(where).toEqual({
      visibility: "PUBLIC",
      OR: [{ formats: { contains: '"psd"' } }],
      topics: { some: { topic: "design" } },
    });
    expect((await app.inject({ method: "GET", url: "/explore/repos?format=nope" })).statusCode).toBe(400);
  });

  it("scans the formats of repositories that haven't been scanned", async () => {
    vi.mocked(prisma.repo.findMany)
      .mockResolvedValueOnce([{ id: "r1", storageKey: "../escape.git" }] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.repo.count).mockResolvedValue(0 as never);
    await app.inject({ method: "GET", url: "/explore/repos" });
    // An unreadable repo is recorded as holding nothing, so it isn't rescanned every
    // time; raw SQL, so the scan leaves the repo's "Updated" time alone.
    const [sql, ...values] = vi.mocked(prisma.$executeRaw).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).toBe('UPDATE "Repo" SET "formats" = ? WHERE "id" = ?');
    expect(values).toEqual(["[]", "r1"]);
  });

  it("counts public repositories per format family", async () => {
    vi.mocked(prisma.repo.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ formats: '["psd","png"]' }, { formats: '["obj"]' }, { formats: null }] as never);
    const res = await app.inject({ method: "GET", url: "/explore/formats" });
    const counts = Object.fromEntries(res.json().formats.map((f: { id: string; count: number }) => [f.id, f.count]));
    expect(counts).toMatchObject({ psd: 1, images: 1, "3d": 1, figcraft: 0 });
  });

  it("lists popular topics", async () => {
    vi.mocked(prisma.repoTopic.groupBy).mockResolvedValue([{ topic: "design", _count: { topic: 3 } }] as never);
    const res = await app.inject({ method: "GET", url: "/explore/topics" });
    expect(res.json()).toEqual({ topics: [{ topic: "design", count: 3 }] });
  });
});

describe("scanRepoFormats", () => {
  let repo: Awaited<ReturnType<typeof createTestRepo>>;
  beforeAll(async () => {
    repo = await createTestRepo("test/formats.git");
    __setManifestForTests(`
[formats]
".psd" = { handler = "psd", build = "abc" }
".png" = { handler = "png", build = "abc" }
".json" = { handler = "json", build = "abc" }
`);
  }, 30_000);
  afterAll(async () => {
    __resetManifest();
    await repo.cleanup();
  });

  it("finds the official formats on the default branch, most files first, without generic config", async () => {
    expect(await scanRepoFormats(repo.bareRepoPath)).toEqual([]);
    await makeCommit(repo.workDir, { "a.png": "x", "art/b.PNG": "x", "poster.psd": "x", "package.json": "{}", "README.md": "#" }, "init");
    expect(await scanRepoFormats(repo.bareRepoPath)).toEqual(["png", "psd"]);
  });
});

describe("contribution activity", () => {
  const repoRef = { name: "poster", owner: { handle: "ada" }, org: null };
  it("groups pull requests, issues, reviews and new repositories by month and repository", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "ada", privateProfile: false } as never);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([{ createdAt: new Date("2026-10-02T00:00:00Z"), ...repoRef }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { createdAt: new Date("2026-11-03T00:00:00Z"), state: "MERGED", repo: repoRef },
      { createdAt: new Date("2026-11-04T00:00:00Z"), state: "OPEN", repo: repoRef },
    ] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([{ createdAt: new Date("2026-10-05T00:00:00Z"), state: "CLOSED", repo: repoRef }] as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/users/ada/activity", headers: { authorization: token } });
    expect(res.json().months).toEqual([
      { month: "2026-11", created: [], pulls: [{ repo: "ada/poster", count: 2, merged: 1, open: 1 }], issues: [], reviews: [] },
      {
        month: "2026-10",
        created: [{ repo: "ada/poster", createdAt: "2026-10-02T00:00:00.000Z" }],
        pulls: [],
        issues: [{ repo: "ada/poster", count: 1, closed: 1 }],
        reviews: [],
      },
    ]);
  });
});

describe("private profiles", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "ada", handle: "ada", privateProfile: true } as never);
  });

  it("hide activity, stars and followers from others", async () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: token } }).then((r) => r.json());
    expect(await get("/users/ada/activity")).toEqual({ months: [], private: true });
    expect(await get("/users/ada/contributions")).toMatchObject({ days: [], total: 0, private: true });
    expect(await get("/users/ada/starred")).toMatchObject({ repos: [], private: true });
    expect(await get("/users/ada/followers")).toEqual({ users: [], private: true });
    expect(prisma.star.findMany).not.toHaveBeenCalled();
    expect(prisma.follow.findMany).not.toHaveBeenCalled();
  });

  it("hide the status and follow counts on the profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "ada", handle: "ada", email: "ada@x.io", displayName: null, bio: null, location: null, website: null, avatarKey: null,
      createdAt: new Date("2026-01-01"), statusText: "Away", privateProfile: true,
    } as never);
    vi.mocked(prisma.follow.findUnique).mockResolvedValue({ followerId: ME } as never);
    const res = await app.inject({ method: "GET", url: "/users/ada", headers: { authorization: token } });
    expect(res.json()).toMatchObject({ handle: "ada", privateProfile: true, status: null, followers: null, following: null, viewerFollows: true });
  });

  it("still show them to the owner", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: ME, handle: "me", privateProfile: true } as never);
    vi.mocked(prisma.follow.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/users/me/followers", headers: { authorization: token } });
    expect(res.json()).toEqual({ users: [] });
  });
});
