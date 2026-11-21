/**
 * Import a repository from GitHub (#289): who may start or retry one, and what
 * is refused before anything is created. GitHub's API is stubbed and the job is
 * mocked; github-import.test.ts covers the job itself.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    repo: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    repoRedirect: { findUnique: vi.fn().mockResolvedValue(null) },
    watch: { upsert: vi.fn() },
    githubIssueImport: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../github-issue-import.js", () => ({
  startIssueImport: vi.fn(),
  startIssueImportIfAsked: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../git-storage.js", async (orig) => ({
  ...(await orig<typeof import("../git-storage.js")>()),
  createBareRepo: vi.fn().mockResolvedValue("/srv/git/ada/hello-world.git"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../github-import.js", async (orig) => ({
  ...(await orig<typeof import("../github-import.js")>()),
  runGithubImport: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { createBareRepo, moveBareRepo, removeBareRepo } from "../git-storage.js";
import { runGithubImport } from "../github-import.js";
import { startIssueImport, startIssueImportIfAsked } from "../github-issue-import.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ADA = "user-ada";
const BOB = "user-bob";
const publicRepo = {
  full_name: "octocat/Hello-World", private: false, size: 108, description: "My first repository",
  topics: ["demo"], default_branch: "master",
};

describe("GitHub import routes", () => {
  let app: FastifyInstance;
  let ada: string;
  let bob: string;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    app = await createTestServer();
    ada = await authHeader(app, ADA);
    bob = await authHeader(app, BOB);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "ada" } as never);
    vi.mocked(prisma.repo.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.repo.count).mockResolvedValue(0);
    vi.mocked(prisma.repo.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data, id: "repo-1", createdAt: new Date(), updatedAt: new Date(), owner: { handle: "ada" }, org: null, topics: [],
    })) as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  function github(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
  function importRepo(payload: Record<string, unknown>, token: string | null = ada) {
    return app.inject({
      method: "POST", url: "/repos", payload,
      headers: token ? { authorization: token } : {},
    });
  }

  describe("POST /repos with importFrom", () => {
    it("401 when signed out", async () => {
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" }, null);
      expect(res.statusCode).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      "https://evil.example/octocat/Hello-World",
      "https://github.com.evil.example/octocat/Hello-World",
      "file:///etc/passwd",
      "ext::sh -c id/x",
      "--upload-pack=id/x",
      "http://github.com/octocat/Hello-World",
    ])("400 for %j, without asking GitHub or creating anything", async (importFrom) => {
      const res = await importRepo({ name: "hello-world", importFrom });
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createBareRepo).not.toHaveBeenCalled();
    });

    it("400 when asked to start from a template too", async () => {
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World", template: "acme/starter" });
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("403 for an organization the caller isn't in, before asking GitHub", async () => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-1", handle: "acme" } as never);
      vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);
      const res = await importRepo({ name: "hello-world", owner: "acme", importFrom: "octocat/Hello-World" });
      expect(res.statusCode).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("404 with a clear message for a private or missing repository, and nothing created", async () => {
      github(404, { message: "Not Found" });
      const res = await importRepo({ name: "secret", importFrom: "https://github.com/octocat/secret" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/Only public repositories can be imported/);
      expect(createBareRepo).not.toHaveBeenCalled();
      expect(prisma.repo.create).not.toHaveBeenCalled();
    });

    it("413 with a clear message for a repository over the cap, and nothing created", async () => {
      github(200, { ...publicRepo, size: 5 * 1024 * 1024 });
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatch(/1 GB/);
      expect(createBareRepo).not.toHaveBeenCalled();
    });

    it("409 for a name already taken, without spending a GitHub request", async () => {
      vi.mocked(prisma.repo.findUnique).mockResolvedValue({ id: "repo-0" } as never);
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" });
      expect(res.statusCode).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("429 while another of the caller's imports is running", async () => {
      vi.mocked(prisma.repo.count).mockResolvedValue(1);
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" });
      expect(res.statusCode).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("201: a public repository in the importing state, with GitHub's description and topics, and the job started", async () => {
      github(200, publicRepo);
      const res = await importRepo({ name: "hello-world", visibility: "private", importFrom: "https://github.com/octocat/hello-world.git" });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: "hello-world", visibility: "public", importStatus: "importing", importSource: "octocat/Hello-World" });
      const { data } = vi.mocked(prisma.repo.create).mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        visibility: "PUBLIC", description: "My first repository", importSource: "octocat/Hello-World", importStatus: "importing",
        topics: { create: [{ topic: "demo" }] },
      });
      const [, repo, actor, source] = vi.mocked(runGithubImport).mock.calls[0]!;
      expect([repo, actor]).toEqual([{ id: "repo-1", storageKey: "ada/hello-world.git" }, ADA]);
      expect(source).toMatchObject({ owner: "octocat", name: "Hello-World", defaultBranch: "master" });
    });

    it("with importIssues: the issue import waits for the git history, then starts (#289, phase 2)", async () => {
      github(200, publicRepo);
      await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World", importIssues: true });
      const { data } = vi.mocked(prisma.repo.create).mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data.issueImport).toEqual({ create: {} });
      await vi.waitFor(() => expect(startIssueImportIfAsked).toHaveBeenCalledWith(expect.anything(), "repo-1"));
    });

    it("without it: no issue import", async () => {
      github(200, publicRepo);
      await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" });
      const { data } = vi.mocked(prisma.repo.create).mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("issueImport");
    });

    it("keeps a description the caller gave", async () => {
      github(200, publicRepo);
      await importRepo({ name: "hello-world", description: "Mine now", importFrom: "octocat/Hello-World" });
      const { data } = vi.mocked(prisma.repo.create).mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data.description).toBe("Mine now");
    });

    it("removes the bare repository it made when the row can't be written", async () => {
      github(200, publicRepo);
      vi.mocked(prisma.repo.create).mockRejectedValueOnce({ code: "P2002" });
      const res = await importRepo({ name: "hello-world", importFrom: "octocat/Hello-World" });
      expect(res.statusCode).toBe(409);
      expect(removeBareRepo).toHaveBeenCalledWith("ada/hello-world.git");
      expect(runGithubImport).not.toHaveBeenCalled();
    });
  });

  describe("POST /repos/:handle/:name/import/retry", () => {
    const failed = {
      id: "repo-1", name: "hello-world", visibility: "PUBLIC", storageKey: "ada/hello-world.git", ownerId: ADA,
      orgId: null, org: null, collaborators: [], teamAccess: [], archivedAt: null,
      importSource: "octocat/Hello-World", importStatus: "failed", importError: "The server restarted during the import.",
    };
    const retry = (token: string | null = ada) =>
      app.inject({ method: "POST", url: "/repos/ada/hello-world/import/retry", headers: token ? { authorization: token } : {} });

    beforeEach(() => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(failed as never);
      vi.mocked(prisma.repo.updateMany).mockResolvedValue({ count: 1 } as never);
    });

    it("401 when signed out", async () => {
      expect((await retry(null)).statusCode).toBe(401);
    });

    it("404 for someone who can't see the repository", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...failed, visibility: "PRIVATE" } as never);
      expect((await retry(bob)).statusCode).toBe(404);
    });

    it("403 for a reader who doesn't administer it", async () => {
      expect((await retry(bob)).statusCode).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("409 when there is no failed import", async () => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...failed, importStatus: null } as never);
      expect((await retry()).statusCode).toBe(409);
      vi.mocked(prisma.repo.findFirst).mockResolvedValue({ ...failed, importStatus: "importing" } as never);
      expect((await retry()).statusCode).toBe(409);
      expect(runGithubImport).not.toHaveBeenCalled();
    });

    it("checks GitHub again: a source gone private stays failed", async () => {
      github(404, { message: "Not Found" });
      expect((await retry()).statusCode).toBe(404);
      expect(prisma.repo.updateMany).not.toHaveBeenCalled();
      expect(runGithubImport).not.toHaveBeenCalled();
    });

    it("202: back to importing, and the job runs again", async () => {
      github(200, publicRepo);
      const res = await retry();
      expect(res.statusCode).toBe(202);
      expect(prisma.repo.updateMany).toHaveBeenCalledWith({
        where: { id: "repo-1", importStatus: "failed" },
        data: { importStatus: "importing", importError: null },
      });
      const [, repo, actor, source] = vi.mocked(runGithubImport).mock.calls[0]!;
      expect([repo, actor]).toEqual([{ id: "repo-1", storageKey: "ada/hello-world.git" }, ADA]);
      expect(source).toMatchObject({ name: "Hello-World" });
    });

    it("409 when another retry got there first", async () => {
      github(200, publicRepo);
      vi.mocked(prisma.repo.updateMany).mockResolvedValue({ count: 0 } as never);
      expect((await retry()).statusCode).toBe(409);
      expect(runGithubImport).not.toHaveBeenCalled();
    });
  });

  describe("the issue import (#289, phase 2)", () => {
    const imported = {
      id: "repo-1", name: "hello-world", visibility: "PUBLIC", storageKey: "ada/hello-world.git", ownerId: ADA,
      orgId: null, org: null, collaborators: [], teamAccess: [], archivedAt: null, importSource: "octocat/Hello-World", importStatus: null,
    };
    beforeEach(() => {
      vi.mocked(prisma.repo.findFirst).mockResolvedValue(imported as never);
    });

    it("anyone who can read the repository sees how far it has got", async () => {
      vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValueOnce({
        repoId: "repo-1", stage: "comments", page: 3, issues: 140, pulls: 37, comments: 212, releases: 0, waitUntil: new Date(Date.now() + 600_000), error: null,
      } as never);
      const res = await app.inject({ method: "GET", url: "/repos/ada/hello-world/import/issues", headers: { authorization: bob } });
      expect(res.json()).toEqual({
        import: { source: "octocat/Hello-World", stage: "comments", issues: 140, pulls: 37, comments: 212, releases: 0, waitUntil: expect.any(String), error: null },
      });
      vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValueOnce(null);
      expect((await app.inject({ method: "GET", url: "/repos/ada/hello-world/import/issues" })).json()).toEqual({ import: null });
    });

    it("Retry: admins only, and only a stopped one", async () => {
      const retry = (token: string) => app.inject({ method: "POST", url: "/repos/ada/hello-world/import/issues/retry", headers: { authorization: token } });
      expect((await retry(bob)).statusCode).toBe(403);
      vi.mocked(prisma.githubIssueImport.updateMany).mockResolvedValueOnce({ count: 0 } as never);
      expect((await retry(ada)).statusCode).toBe(409);
      expect(startIssueImport).not.toHaveBeenCalled();
      vi.mocked(prisma.githubIssueImport.updateMany).mockResolvedValueOnce({ count: 1 } as never);
      expect((await retry(ada)).statusCode).toBe(202);
      expect(prisma.githubIssueImport.updateMany).toHaveBeenLastCalledWith({ where: { repoId: "repo-1", error: { not: null } }, data: { error: null } });
      expect(startIssueImport).toHaveBeenCalledWith(expect.anything(), "repo-1");
    });
  });

  it("refuses to delete a repository while it imports", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      id: "repo-1", name: "hello-world", storageKey: "ada/hello-world.git", ownerId: ADA, orgId: null, org: null, importStatus: "importing",
    } as never);
    const res = await app.inject({ method: "DELETE", url: "/repos/ada/hello-world", headers: { authorization: ada } });
    expect(res.statusCode).toBe(409);
    expect(prisma.repo.delete).not.toHaveBeenCalled();
    expect(removeBareRepo).not.toHaveBeenCalled();
  });

  it("refuses the legacy rename while it imports", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue({
      id: "repo-1", name: "hello-world", storageKey: "ada/hello-world.git", ownerId: ADA, orgId: null, owner: { handle: "ada" }, importStatus: "importing",
    } as never);
    const res = await app.inject({ method: "PATCH", url: "/repos/hello-world/rename", headers: { authorization: ada }, payload: { name: "hi" } });
    expect(res.statusCode).toBe(409);
    expect(moveBareRepo).not.toHaveBeenCalled();
  });
});
