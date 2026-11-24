/**
 * Import a repository from GitHub (#289): the URL parser at the trust boundary,
 * the metadata checks, and the background job with git and GitHub mocked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: { repo: { update: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("../git-storage.js", () => ({
  bareRepoPathFromKey: (key: string) => `/srv/git/${key}`,
}));
vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn(),
  setDefaultBranch: vi.fn(),
}));
vi.mock("../git-push-shared.js", () => ({
  runPostReceiveEffects: vi.fn(),
}));

import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { branchExists, setDefaultBranch } from "../git-utils.js";
import { runPostReceiveEffects } from "../git-push-shared.js";
import {
  failInterruptedImports, fetchGithubOrg, fetchGithubRepo, ImportError, MAX_IMPORT_KB, MAX_ORG_REPO_PAGES, parseGithubOrg,
  parseGithubRepo, runGithubImport, type GithubRepo,
} from "../github-import.js";

describe("parseGithubRepo", () => {
  it.each([
    ["https://github.com/octocat/Hello-World", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World.git", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World/", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World.git/", "octocat", "Hello-World"],
    ["  octocat/hello.world_2  ", "octocat", "hello.world_2"],
    ["a-b/.github", "a-b", ".github"],
  ])("accepts %j", (input, owner, name) => {
    expect(parseGithubRepo(input)).toEqual({ owner, name });
  });

  it.each([
    "",
    "octocat",
    "http://github.com/octocat/Hello-World", // https only
    "HTTPS://GITHUB.COM/octocat/Hello-World",
    "github.com/octocat/Hello-World",
    "https://www.github.com/octocat/Hello-World",
    "https://github.com.evil.example/octocat/Hello-World",
    "https://evil.example/octocat/Hello-World",
    "https://github.com@evil.example/octocat/Hello-World",
    "https://user:pass@github.com/octocat/Hello-World",
    "https://github.com:443/octocat/Hello-World",
    "https://github.com/octocat/Hello-World/tree/main",
    "https://github.com/octocat/Hello-World?tab=readme",
    "https://github.com/octocat/Hello-World#readme",
    "https://github.com/octocat",
    "ssh://git@github.com/octocat/Hello-World.git",
    "git@github.com:octocat/Hello-World.git",
    "file:///etc/passwd",
    "ext::sh -c touch% /tmp/pwned",
    "ext::sh/x",
    "--upload-pack=touch /tmp/pwned/x",
    "-o/x",
    "octocat/..",
    "octocat/.",
    "../etc/passwd",
    "octocat/Hello%2e%2e",
    "octocat/Hello World",
    "octocat/Hello\nWorld",
    "octo_cat/Hello-World", // not a GitHub login
    "octocat-/Hello-World",
    `${"a".repeat(40)}/x`,
    `octocat/${"a".repeat(101)}`,
    "octocat/Hellо-World", // Cyrillic о
  ])("rejects %j", (input) => {
    expect(parseGithubRepo(input)).toBeNull();
  });
});

describe("fetchGithubRepo", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", ""); // whatever the shell running the tests has
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers }));
  const publicRepo = {
    full_name: "octocat/Hello-World", private: false, size: 108, description: "  My first repository  ",
    topics: ["demo", "Not A Topic", "3d"], default_branch: "master",
  };
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ImportError);

  it("asks GitHub's API without a token and keeps what an import needs", async () => {
    answer(200, publicRepo);
    expect(await fetchGithubRepo("octocat", "hello-world")).toEqual({
      owner: "octocat", name: "Hello-World", description: "My first repository", topics: ["demo", "3d"], defaultBranch: "master",
      archived: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/octocat/hello-world");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("says when GitHub has the repository archived", async () => {
    answer(200, { ...publicRepo, archived: true });
    expect((await fetchGithubRepo("octocat", "hello-world")).archived).toBe(true);
  });

  it("refuses a repository GitHub doesn't show (missing, or private)", async () => {
    answer(404, { message: "Not Found" });
    const e = await refusal(fetchGithubRepo("octocat", "secret"));
    expect(e).toBeInstanceOf(ImportError);
    expect(e!.status).toBe(404);
    expect(e!.message).toMatch(/only public repositories/i);
  });

  it("refuses a repository marked private", async () => {
    answer(200, { ...publicRepo, private: true });
    expect((await refusal(fetchGithubRepo("octocat", "Hello-World")))!.status).toBe(404);
  });

  it("refuses a repository over the size cap before any download", async () => {
    answer(200, { ...publicRepo, size: MAX_IMPORT_KB + 1 });
    const e = await refusal(fetchGithubRepo("octocat", "Hello-World"));
    expect(e!.status).toBe(413);
    expect(e!.message).toMatch(/1 GB/);
  });

  it("accepts a repository exactly at the cap", async () => {
    answer(200, { ...publicRepo, size: MAX_IMPORT_KB });
    await expect(fetchGithubRepo("octocat", "Hello-World")).resolves.toMatchObject({ name: "Hello-World" });
  });

  it("refuses an answer with no size, or a name that isn't a GitHub repository", async () => {
    answer(200, { ...publicRepo, size: undefined });
    expect((await refusal(fetchGithubRepo("octocat", "Hello-World")))!.status).toBe(502);
    answer(200, { ...publicRepo, full_name: "ext::sh/x" });
    expect((await refusal(fetchGithubRepo("octocat", "Hello-World")))!.status).toBe(502);
  });

  it("says when the server's hourly GitHub requests are used up", async () => {
    answer(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    const e = await refusal(fetchGithubRepo("octocat", "Hello-World"));
    expect(e!.status).toBe(503);
    expect(e!.message).toMatch(/60 GitHub requests/);
    expect(e!.message).toMatch(/Try again later\.$/);
  });

  it("says how many requests the hour had and when they come back, from GitHub's headers", async () => {
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
    const reset = String(Math.floor(Date.now() / 1000) + 11 * 60 + 30);
    answer(429, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": reset });
    const e = await refusal(fetchGithubRepo("octocat", "Hello-World"));
    expect(e!.status).toBe(503);
    expect(e!.message).toBe("This server has used up its 5,000 GitHub requests for the hour. Try again in 12 minutes.");
    // So a queue can wait for them (#308).
    expect(e!.resetAt).toEqual(new Date(Number(reset) * 1000));
  });

  describe("with FORGEHUB_GITHUB_TOKEN set", () => {
    it("sends it to GitHub's API, trimmed, for 5,000 requests an hour instead of 60", async () => {
      vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "  github_pat_test\n");
      answer(200, publicRepo);
      await expect(fetchGithubRepo("octocat", "Hello-World")).resolves.toMatchObject({ name: "Hello-World" });
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.headers).toMatchObject({ Authorization: "Bearer github_pat_test", "User-Agent": "ForgeHub" });
    });

    it("still refuses a private repository the token's owner can see", async () => {
      vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
      answer(200, { ...publicRepo, private: true });
      const e = await refusal(fetchGithubRepo("octocat", "Hello-World"));
      expect(e!.status).toBe(404);
      expect(e!.message).toMatch(/only public repositories/i);
    });

    it("says the token was refused, without showing it", async () => {
      vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
      answer(401, { message: "Bad credentials" });
      const e = await refusal(fetchGithubRepo("octocat", "Hello-World"));
      expect(e!.status).toBe(502);
      expect(e!.message).toMatch(/refused this server's token/);
      expect(e!.message).not.toContain("github_pat_test");
    });

    it("a blank one counts as unset", async () => {
      vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "   ");
      answer(200, publicRepo);
      await fetchGithubRepo("octocat", "Hello-World");
      expect(JSON.stringify(fetchMock.mock.calls[0]![1].headers)).not.toMatch(/authorization/i);
    });
  });

  it("reports GitHub being unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await refusal(fetchGithubRepo("octocat", "Hello-World")))!.status).toBe(502);
  });
});

describe("runGithubImport", () => {
  const app = { log: { error: vi.fn() } } as unknown as FastifyInstance;
  const repo = { id: "repo-1", storageKey: "ada/hello.git" };
  const source: GithubRepo = { owner: "octocat", name: "Hello-World", description: null, topics: [], defaultBranch: "master", archived: false };

  /** Answer the next git call the way promisify(execFile) expects. */
  function git(err: (Error & { killed?: boolean }) | null) {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      (args[args.length - 1] as (e: unknown, r?: unknown) => void)(err, { stdout: "", stderr: "" });
    }) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repo.update).mockResolvedValue({} as never);
    vi.mocked(branchExists).mockResolvedValue(true);
  });

  it("fetches only branches and tags, from a URL it builds, with git kept non-interactive", async () => {
    git(null);
    await runGithubImport(app, repo, "user-ada", source);

    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0]! as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; timeout: number }];
    expect(cmd).toBe("git");
    // The bare repository is named outright (safe.bareRepository=explicit hosts).
    expect(args.slice(0, 2)).toEqual(["--git-dir", "/srv/git/ada/hello.git"]);
    expect(args).toContain("credential.helper=");
    const rest = args.slice(args.indexOf("--") + 1);
    expect(rest).toEqual(["https://github.com/octocat/Hello-World.git", "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]);
    expect(args.join(" ")).not.toMatch(/refs\/pull|\+refs/);
    expect(opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", GIT_ASKPASS: "" });
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("on success: points HEAD at GitHub's default branch, clears the state, and runs what a push runs", async () => {
    git(null);
    await runGithubImport(app, repo, "user-ada", source);

    expect(setDefaultBranch).toHaveBeenCalledWith("ada/hello.git", "master");
    expect(prisma.repo.update).toHaveBeenCalledWith({ where: { id: "repo-1" }, data: { importStatus: null, importError: null } });
    expect(runPostReceiveEffects).toHaveBeenCalledWith(app, repo, "user-ada", "/srv/git/ada/hello.git", new Map());
    // Not archived on GitHub: left as it is.
    expect(prisma.repo.updateMany).not.toHaveBeenCalled();
  });

  it("archives a repository GitHub has archived, once its history is in and its push effects ran", async () => {
    git(null);
    await runGithubImport(app, repo, "user-ada", { ...source, archived: true });
    expect(prisma.repo.updateMany).toHaveBeenCalledWith({
      where: { id: "repo-1", archivedAt: null },
      data: { archivedAt: expect.any(Date) },
    });
    expect(vi.mocked(runPostReceiveEffects).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(prisma.repo.updateMany).mock.invocationCallOrder[0]!,
    );
  });

  it("leaves a failed import of an archived repository unarchived, so it can be retried", async () => {
    git(Object.assign(new Error("fatal: repository not found"), { killed: false }));
    await runGithubImport(app, repo, "user-ada", { ...source, archived: true });
    expect(prisma.repo.updateMany).not.toHaveBeenCalled();
  });

  it("never hands git the server's GitHub token", async () => {
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
    git(null);
    await runGithubImport(app, repo, "user-ada", source);
    vi.unstubAllEnvs();
    const [, args, opts] = vi.mocked(execFile).mock.calls[0]! as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(JSON.stringify(args)).not.toContain("github_pat_test");
    expect(opts.env).not.toHaveProperty("FORGEHUB_GITHUB_TOKEN");
    expect(JSON.stringify(opts.env)).not.toContain("github_pat_test");
  });

  it("leaves HEAD alone for an empty repository", async () => {
    git(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    await runGithubImport(app, repo, "user-ada", source);
    expect(setDefaultBranch).not.toHaveBeenCalled();
    expect(prisma.repo.update).toHaveBeenCalledWith(expect.objectContaining({ data: { importStatus: null, importError: null } }));
  });

  it("on a failed fetch: records a plain message, not git's, and runs nothing else", async () => {
    git(new Error("fatal: unable to write to /srv/git/ada/hello.git/objects"));
    await runGithubImport(app, repo, "user-ada", source);

    const { data } = vi.mocked(prisma.repo.update).mock.calls[0]![0] as { data: { importStatus: string; importError: string } };
    expect(data.importStatus).toBe("failed");
    expect(data.importError).toMatch(/Could not fetch github\.com\/octocat\/Hello-World/);
    expect(data.importError).not.toContain("/srv/git");
    expect(runPostReceiveEffects).not.toHaveBeenCalled();
  });

  it("on a fetch stopped by the timeout: says so", async () => {
    git(Object.assign(new Error("killed"), { killed: true }));
    await runGithubImport(app, repo, "user-ada", source);
    const { data } = vi.mocked(prisma.repo.update).mock.calls[0]![0] as { data: { importError: string } };
    expect(data.importError).toMatch(/longer than 30 minutes/);
  });

  it("never throws when the repository was deleted meanwhile", async () => {
    git(null);
    vi.mocked(prisma.repo.update).mockRejectedValue(Object.assign(new Error("gone"), { code: "P2025" }));
    await expect(runGithubImport(app, repo, "user-ada", source)).resolves.toBeUndefined();
    git(new Error("fatal"));
    await expect(runGithubImport(app, repo, "user-ada", source)).resolves.toBeUndefined();
  });
});

describe("failInterruptedImports", () => {
  it("marks every import a restart cut short as failed, so it can be retried", async () => {
    vi.mocked(prisma.repo.updateMany).mockResolvedValue({ count: 2 } as never);
    expect(await failInterruptedImports()).toBe(2);
    expect(prisma.repo.updateMany).toHaveBeenCalledWith({
      where: { importStatus: "importing" },
      data: { importStatus: "failed", importError: expect.stringMatching(/restarted/) },
    });
  });
});

describe("parseGithubOrg (#308)", () => {
  it.each([
    ["pallets", "pallets"],
    ["  octo-org  ", "octo-org"],
    ["https://github.com/octo-org", "octo-org"],
    ["https://github.com/octo-org/", "octo-org"],
  ])("accepts %j", (input, login) => {
    expect(parseGithubOrg(input)).toBe(login);
  });

  it.each([
    "",
    "octo-org/hello",
    "https://github.com/octo-org/hello",
    "http://github.com/octo-org",
    "https://evil.example/octo-org",
    "-octo",
    "octo--org/..",
    "../etc",
    "a".repeat(40),
  ])("refuses %j", (input) => {
    expect(parseGithubOrg(input)).toBeNull();
  });
});

describe("fetchGithubOrg (#308)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers }));
  const repo = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, private: false, size: 10, description: null, fork: false, archived: false, ...extra });
  const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

  it("asks for the organization, then its public repositories a page of 100 at a time", async () => {
    answer(200, { login: "Pallets", name: "  Pallets  ", description: "Python projects" });
    answer(200, Array.from({ length: 100 }, (_, i) => repo(`r${i}`)));
    answer(200, [repo("werkzeug", { description: " WSGI ", size: 9000, fork: true, archived: true })]);
    const org = await fetchGithubOrg("pallets");
    expect(urls()).toEqual([
      "https://api.github.com/orgs/pallets",
      "https://api.github.com/orgs/Pallets/repos?type=public&sort=full_name&per_page=100&page=1",
      "https://api.github.com/orgs/Pallets/repos?type=public&sort=full_name&per_page=100&page=2",
    ]);
    expect(org).toMatchObject({ login: "Pallets", displayName: "Pallets", description: "Python projects", truncated: false });
    expect(org.repos).toHaveLength(101);
    expect(org.repos.at(-1)).toEqual({ name: "werkzeug", description: "WSGI", sizeKb: 9000, fork: true, archived: true });
  });

  it("never lists a private repository, nor one whose name or size isn't GitHub's", async () => {
    answer(200, { login: "acme" });
    answer(200, [repo("open"), repo("secret", { private: true }), repo("odd", { private: undefined }), repo("../x"), repo("nosize", { size: "1" })]);
    expect((await fetchGithubOrg("acme")).repos.map((r) => r.name)).toEqual(["open"]);
  });

  it(`stops after ${MAX_ORG_REPO_PAGES} full pages and says the list is cut short`, async () => {
    answer(200, { login: "huge" });
    for (let p = 0; p < MAX_ORG_REPO_PAGES; p++) answer(200, Array.from({ length: 100 }, (_, i) => repo(`p${p}-${i}`)));
    const org = await fetchGithubOrg("huge");
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_ORG_REPO_PAGES);
    expect(org.repos).toHaveLength(100 * MAX_ORG_REPO_PAGES);
    expect(org.truncated).toBe(true);
  });

  it("404 for a name that isn't an organization (a person's account answers 404 here too)", async () => {
    answer(404, { message: "Not Found" });
    await expect(fetchGithubOrg("octocat")).rejects.toMatchObject({ status: 404, message: "There is no GitHub organization named octocat." });
  });

  it("says when the server's hourly requests are used up, partway through the list too", async () => {
    answer(200, { login: "acme" });
    answer(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    await expect(fetchGithubOrg("acme")).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/60 GitHub requests/) });
  });

  it("sends the server's token when it has one", async () => {
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
    answer(200, { login: "acme" });
    answer(200, []);
    await fetchGithubOrg("acme");
    for (const [, init] of fetchMock.mock.calls) expect(init.headers).toMatchObject({ Authorization: "Bearer github_pat_test" });
  });

  it("refuses an answer that isn't an organization or a list", async () => {
    answer(200, { message: "?" });
    await expect(fetchGithubOrg("acme")).rejects.toMatchObject({ status: 502 });
    answer(200, { login: "acme" });
    answer(200, { not: "a list" });
    await expect(fetchGithubOrg("acme")).rejects.toMatchObject({ status: 502 });
  });
});
