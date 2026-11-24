/**
 * Import a GitHub organization (#308): looking it up, who may import into what,
 * every name checked before anything is made, and the progress page's data.
 * GitHub's API is stubbed; the queue is mocked (github-import-queue.test.ts covers it).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    repo: { findMany: vi.fn(), create: vi.fn() },
    repoRedirect: { findUnique: vi.fn().mockResolvedValue(null) },
    watch: { upsert: vi.fn() },
  },
}));
vi.mock("../git-storage.js", async (orig) => ({
  ...(await orig<typeof import("../git-storage.js")>()),
  createBareRepo: vi.fn().mockResolvedValue("/srv/git/x.git"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../github-import-queue.js", async (orig) => ({
  ...(await orig<typeof import("../github-import-queue.js")>()),
  runImportQueue: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { createBareRepo, removeBareRepo } from "../git-storage.js";
import { runImportQueue } from "../github-import-queue.js";
import { authHeader, createTestServer } from "./helpers/server.js";

const ADA = "user-ada";

describe("GitHub organization import routes (#308)", () => {
  let app: FastifyInstance;
  let ada: string;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    app = await createTestServer();
    ada = await authHeader(app, ADA);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "");
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.repo.findMany).mockResolvedValue([]);
    vi.mocked(prisma.organization.create).mockResolvedValue({ id: "org-new" } as never);
    let n = 0;
    vi.mocked(prisma.repo.create).mockImplementation((async () => ({ id: `repo-${++n}` })) as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function github(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
  const lookup = (login: string, token: string | null = ada) =>
    app.inject({ method: "GET", url: `/import/github/orgs/${login}`, headers: token ? { authorization: token } : {} });
  const start = (payload: Record<string, unknown>, login = "pallets", token: string | null = ada) =>
    app.inject({ method: "POST", url: `/import/github/orgs/${login}`, payload, headers: token ? { authorization: token } : {} });
  const intoNew = { create: true, handle: "pallets", displayName: "Pallets", description: "Python projects" };
  const two = [{ name: "Flask", as: "flask" }, { name: "click", as: "click" }];

  describe("GET /import/github/orgs/:login", () => {
    it("401 when signed out: each look spends the server's GitHub requests", async () => {
      expect((await lookup("pallets", null)).statusCode).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("400 for something that isn't an organization name, without asking GitHub", async () => {
      expect((await lookup("-bad-")).statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the organization, its public repositories and the size cap", async () => {
      github(200, { login: "pallets", name: "Pallets", description: null });
      github(200, [{ name: "flask", private: false, size: 12, fork: false, archived: false }]);
      const res = await lookup("pallets");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        login: "pallets", displayName: "Pallets", description: null, truncated: false, maxSizeKb: 1024 * 1024,
        website: null, location: null, avatarUrl: null,
        repos: [{ name: "flask", description: null, sizeKb: 12, fork: false, archived: false }],
      });
    });

    it("GitHub's refusal, as a message for the person", async () => {
      github(404, { message: "Not Found" });
      const res = await lookup("nobody-here");
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("There is no GitHub organization named nobody-here.");
    });
  });

  describe("POST /import/github/orgs/:login", () => {
    it("401 when signed out", async () => {
      expect((await start({ into: intoNew, repos: two }, "pallets", null)).statusCode).toBe(401);
    });

    it.each([
      ["no repositories", { into: intoNew, repos: [] }],
      ["a name that can't be one here", { into: intoNew, repos: [{ name: "flask", as: "fl/ask" }] }],
      ["a GitHub name that can't be one", { into: intoNew, repos: [{ name: "../x", as: "x" }] }],
      ["a reserved organization name", { into: { create: true, handle: "settings" }, repos: two }],
    ])("400 for %s, with nothing made", async (_what, payload) => {
      expect((await start(payload)).statusCode).toBe(400);
      expect(prisma.organization.create).not.toHaveBeenCalled();
      expect(createBareRepo).not.toHaveBeenCalled();
    });

    it("400 when two would get the same name here, naming it", async () => {
      const res = await start({ into: intoNew, repos: [{ name: "Flask", as: "web" }, { name: "click", as: "WEB" }] });
      expect(res.statusCode).toBe(400);
      expect(res.json().taken).toEqual(["web"]);
      expect(createBareRepo).not.toHaveBeenCalled();
    });

    it("400 when one repository is picked twice", async () => {
      const res = await start({ into: intoNew, repos: [{ name: "flask", as: "a" }, { name: "Flask", as: "b" }] });
      expect(res.statusCode).toBe(400);
    });

    it("409 for a new organization whose name is taken, by a person or an organization", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: "u", handle: "pallets" } as never);
      const res = await start({ into: intoNew, repos: two });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ field: "handle" });
      expect(prisma.organization.create).not.toHaveBeenCalled();
      expect(createBareRepo).not.toHaveBeenCalled();
    });

    it("gives a new organization the GitHub one's website, location and avatar", async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
      fetchMock.mockResolvedValueOnce(new Response(png, { status: 200 }));
      vi.mocked(prisma.organization.update).mockResolvedValue({} as never);
      const avatarUrl = "https://avatars.githubusercontent.com/u/16748505?v=4";
      const res = await start({
        into: { ...intoNew, website: "https://palletsprojects.com", location: "Earth", avatarUrl },
        repos: two,
      });
      expect(res.statusCode).toBe(201);
      expect(vi.mocked(prisma.organization.create).mock.calls[0]![0]).toMatchObject({
        data: { website: "https://palletsprojects.com", location: "Earth" },
      });
      await vi.waitFor(() =>
        expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: "org-new" }, data: { avatarKey: expect.any(String) } }),
      );
      expect(String(fetchMock.mock.calls[0]![0])).toBe(avatarUrl);
    });

    it("400 for an avatar anywhere but GitHub's avatar host, or a website that isn't a web address", async () => {
      for (const extra of [{ avatarUrl: "https://example.com/a.png" }, { website: "javascript:alert(1)" }]) {
        expect((await start({ into: { ...intoNew, ...extra }, repos: two })).statusCode).toBe(400);
      }
      expect(prisma.organization.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("creates the organization with the caller as its owner, then queues each repository in order", async () => {
      const res = await start({ into: intoNew, repos: two, importIssues: true });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ org: "pallets", queued: ["flask", "click"], skipped: [] });
      expect(prisma.organization.create).toHaveBeenCalledWith({
        data: {
          handle: "pallets", displayName: "Pallets", description: "Python projects", website: null, location: null,
          memberships: { create: { userId: ADA, role: "OWNER" } },
        },
        select: { id: true },
      });
      expect(vi.mocked(createBareRepo).mock.calls.map(([k]) => k)).toEqual(["pallets/flask.git", "pallets/click.git"]);
      const created = vi.mocked(prisma.repo.create).mock.calls.map(([a]) => (a as { data: Record<string, unknown> }).data);
      expect(created[0]).toEqual({
        name: "flask", visibility: "PUBLIC", storageKey: "pallets/flask.git", ownerId: ADA, orgId: "org-new",
        importSource: "pallets/Flask", importStatus: "queued", issueImport: { create: {} },
      });
      expect(created[1]).toMatchObject({ name: "click", importSource: "pallets/click" });
      expect(prisma.watch.upsert).toHaveBeenCalledTimes(2);
      expect(runImportQueue).toHaveBeenCalledWith(expect.anything(), ADA);
      // Nothing asked of GitHub here: each repository is checked when its turn comes.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("without importIssues: no issue imports", async () => {
      await start({ into: intoNew, repos: two });
      const created = vi.mocked(prisma.repo.create).mock.calls.map(([a]) => (a as { data: Record<string, unknown> }).data);
      expect(created[0]).not.toHaveProperty("issueImport");
    });

    describe("into an organization the caller already has", () => {
      const into = { create: false, handle: "Acme" };
      beforeEach(() => {
        vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-acme" } as never);
        vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ role: "OWNER" } as never);
      });

      it("404 for one the caller isn't in, as for one that doesn't exist", async () => {
        vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);
        expect((await start({ into, repos: two })).statusCode).toBe(404);
        vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
        expect((await start({ into, repos: two })).statusCode).toBe(404);
        expect(createBareRepo).not.toHaveBeenCalled();
      });

      it("403 for a member who isn't an owner", async () => {
        vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ role: "MEMBER" } as never);
        expect((await start({ into, repos: two })).statusCode).toBe(403);
        expect(createBareRepo).not.toHaveBeenCalled();
      });

      it("409 naming every name already there, with nothing made", async () => {
        vi.mocked(prisma.repo.findMany).mockResolvedValue([{ name: "flask" }, { name: "click" }] as never);
        const res = await start({ into, repos: two });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: "acme already has repositories named flask, click", taken: ["flask", "click"] });
        expect(prisma.repo.findMany).toHaveBeenCalledWith({
          where: { storageKey: { in: ["acme/flask.git", "acme/click.git"] } },
          select: { name: true },
        });
        expect(createBareRepo).not.toHaveBeenCalled();
      });

      it("201: the repositories join it, and no organization is created", async () => {
        const res = await start({ into, repos: two });
        expect(res.statusCode).toBe(201);
        expect(res.json().org).toBe("acme");
        expect(prisma.organization.create).not.toHaveBeenCalled();
        const created = vi.mocked(prisma.repo.create).mock.calls.map(([a]) => (a as { data: Record<string, unknown> }).data);
        expect(created.map((d) => [d.orgId, d.storageKey])).toEqual([["org-acme", "acme/flask.git"], ["org-acme", "acme/click.git"]]);
      });

      it("skips one made meanwhile, never touching storage it didn't make", async () => {
        vi.mocked(createBareRepo).mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));
        vi.mocked(prisma.repo.create).mockRejectedValueOnce({ code: "P2002" });
        const res = await start({ into, repos: [...two, { name: "jinja", as: "jinja" }] });
        expect(res.json()).toEqual({ org: "acme", queued: ["jinja"], skipped: ["flask", "click"] });
        // Only the directory this request made for "click" is removed.
        expect(removeBareRepo).toHaveBeenCalledTimes(1);
        expect(removeBareRepo).toHaveBeenCalledWith("acme/click.git");
      });
    });
  });

  describe("GET /orgs/:handle/imports", () => {
    const get = (token: string | null = ada) =>
      app.inject({ method: "GET", url: "/orgs/acme/imports", headers: token ? { authorization: token } : {} });

    it("401 signed out, and 404 for someone outside the organization", async () => {
      expect((await get(null)).statusCode).toBe(401);
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-acme" } as never);
      expect((await get()).statusCode).toBe(404);
    });

    it("each imported repository, oldest first: waiting, importing, failed or done, with its issue import", async () => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: "org-acme" } as never);
      vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ role: "MEMBER" } as never);
      const later = new Date(Date.now() + 60_000);
      vi.mocked(prisma.repo.findMany).mockResolvedValue([
        { name: "flask", importSource: "pallets/flask", importStatus: null, importError: null,
          issueImport: { stage: "comments", issues: 3, pulls: 1, comments: 0, releases: 0, waitUntil: later, error: null } },
        { name: "click", importSource: "pallets/click", importStatus: "failed", importError: "Gone", issueImport: null },
        { name: "jinja", importSource: "pallets/jinja", importStatus: "queued", importError: null,
          issueImport: { stage: "labels", issues: 0, pulls: 0, comments: 0, releases: 0, waitUntil: new Date(0), error: null } },
      ] as never);
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(prisma.repo.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { orgId: "org-acme", importSource: { not: null } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }));
      expect(res.json()).toEqual({
        viewerRole: "MEMBER",
        repos: [
          { name: "flask", source: "pallets/flask", status: "done", error: null,
            issues: { stage: "comments", issues: 3, pulls: 1, comments: 0, releases: 0, waitUntil: later.toISOString(), error: null } },
          { name: "click", source: "pallets/click", status: "failed", error: "Gone", issues: null },
          { name: "jinja", source: "pallets/jinja", status: "queued", error: null,
            issues: { stage: "labels", issues: 0, pulls: 0, comments: 0, releases: 0, waitUntil: null, error: null } },
        ],
      });
    });
  });
});
