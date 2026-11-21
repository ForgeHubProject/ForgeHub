/**
 * GitHub import, phase 2 (#289): labels, milestones, issues and comments, a page at
 * a time with GitHub and the database mocked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => {
  const op = (name: string) => vi.fn((args: unknown) => ({ op: name, args }));
  return {
    prisma: {
      label: { upsert: op("label.upsert"), findMany: vi.fn() },
      milestone: { upsert: op("milestone.upsert"), findMany: vi.fn() },
      issue: { create: op("issue.create"), findMany: vi.fn() },
      issueComment: { create: op("issueComment.create") },
      pullRequest: { create: op("pullRequest.create"), findMany: vi.fn() },
      pullRequestComment: { create: op("pullRequestComment.create") },
      repo: { updateMany: op("repo.updateMany"), findUniqueOrThrow: vi.fn() },
      githubIssueImport: { update: op("job.update"), updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    },
  };
});
vi.mock("../ghost.js", () => ({ ghostUser: vi.fn().mockResolvedValue({ id: "ghost-id" }) }));
vi.mock("../git-utils.js", () => ({ git: vi.fn() }));

import type { FastifyInstance } from "fastify";
import type { GithubIssueImport } from "@prisma/client";
import { prisma } from "../prisma.js";
import { git } from "../git-utils.js";
import {
  githubGet, GithubFailed, GithubRateLimited, importStep, issueNumberFromUrl, PER_PAGE, runIssueImport,
} from "../github-issue-import.js";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "");
  vi.mocked(prisma.label.findMany).mockResolvedValue([]);
  vi.mocked(prisma.milestone.findMany).mockResolvedValue([]);
  vi.mocked(prisma.issue.findMany).mockResolvedValue([]);
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
  vi.mocked(prisma.repo.findUniqueOrThrow).mockResolvedValue({ storageKey: "ada/hello.git" } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers }));
const job = (overrides: Partial<GithubIssueImport> = {}): GithubIssueImport => ({
  repoId: "repo-1", stage: "labels", page: 1, issues: 0, pulls: 0, comments: 0, waitUntil: null, error: null,
  createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const source = { owner: "octocat", name: "Hello-World" };
/** What the step wrote, in one transaction. */
const written = () => vi.mocked(prisma.$transaction).mock.calls[0]![0] as unknown as Array<{ op: string; args: { where?: unknown; data?: Record<string, unknown>; create?: Record<string, unknown> } }>;
const ops = (name: string) => written().filter((o) => o.op === name);
const cursor = () => ops("job.update")[0]!.args.data;

describe("githubGet", () => {
  it("sends the server's token when it has one", async () => {
    vi.stubEnv("FORGEHUB_GITHUB_TOKEN", "github_pat_test");
    answer([]);
    await githubGet("/repos/octocat/Hello-World/labels");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.github.com/repos/octocat/Hello-World/labels");
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ Authorization: "Bearer github_pat_test" });
  });

  it("tells a used-up hour apart, with when it resets", async () => {
    answer({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795150000" });
    const e = await githubGet("/x").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GithubRateLimited);
    expect((e as GithubRateLimited).resetAt.getTime()).toBe(1795150000 * 1000);
  });

  it("waits out GitHub's secondary limits too", async () => {
    answer({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "60" });
    const e = (await githubGet("/x").catch((err: unknown) => err)) as GithubRateLimited;
    expect(e).toBeInstanceOf(GithubRateLimited);
    expect(e.resetAt.getTime() - Date.now()).toBeGreaterThan(55_000);
  });

  it("anything else is a failure with a plain message", async () => {
    answer({ message: "Not Found" }, 404);
    await expect(githubGet("/x")).rejects.toThrow(new GithubFailed("GitHub answered 404"));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(githubGet("/x")).rejects.toThrow("Could not reach GitHub");
  });
});

describe("issueNumberFromUrl", () => {
  it("reads the number off an issue_url", () => {
    expect(issueNumberFromUrl("https://api.github.com/repos/octocat/Hello-World/issues/1347")).toBe(1347);
    expect(issueNumberFromUrl("https://api.github.com/repos/octocat/Hello-World/pulls/3")).toBeNull();
    expect(issueNumberFromUrl(42)).toBeNull();
  });
});

describe("importStep", () => {
  it("labels: GitHub's colour and description win; a short page moves on to milestones", async () => {
    answer([{ name: "bug", color: "D73A4A", description: "Something isn't working" }, { name: "", color: "fff" }, { name: "odd colour", color: "#zz" }]);
    await importStep(job(), source, "ghost-id");
    expect(fetchMock.mock.calls[0]![0]).toContain(`/repos/octocat/Hello-World/labels?per_page=${PER_PAGE}&page=1`);
    const [bug, odd] = ops("label.upsert");
    expect(bug!.args).toEqual({
      where: { repoId_name: { repoId: "repo-1", name: "bug" } },
      create: { repoId: "repo-1", name: "bug", color: "d73a4a", description: "Something isn't working" },
      update: { color: "d73a4a", description: "Something isn't working" },
    });
    expect(odd!.args.create).toMatchObject({ name: "odd colour", color: "ededed" });
    expect(ops("label.upsert")).toHaveLength(2);
    expect(cursor()).toEqual({ stage: "milestones", page: 1 });
  });

  it("a full page asks for the next one", async () => {
    answer(Array.from({ length: PER_PAGE }, (_, i) => ({ name: `l${i}`, color: "ededed" })));
    await importStep(job({ page: 3 }), source, "ghost-id");
    expect(cursor()).toEqual({ page: 4 });
  });

  it("milestones: keep GitHub's numbers and state, and skip a title already here", async () => {
    vi.mocked(prisma.milestone.findMany).mockResolvedValueOnce([{ title: "v0.9" }] as never);
    answer([
      { number: 2, title: "v1.0", state: "closed", due_on: "2026-01-01T08:00:00Z", closed_at: "2026-01-02T08:00:00Z", created_at: "2025-12-01T08:00:00Z" },
      { number: 1, title: "v0.9", state: "closed" },
    ]);
    await importStep(job({ stage: "milestones" }), source, "ghost-id");
    const [v1] = ops("milestone.upsert");
    expect(ops("milestone.upsert")).toHaveLength(1);
    expect(v1!.args.where).toEqual({ repoId_number: { repoId: "repo-1", number: 2 } });
    expect(v1!.args.create).toMatchObject({
      number: 2, title: "v1.0", state: "CLOSED", dueOn: new Date("2026-01-01T08:00:00Z"), closedAt: new Date("2026-01-02T08:00:00Z"),
    });
    expect(cursor()).toEqual({ stage: "issues", page: 1 });
  });

  it("issues: numbers, state, labels and milestone kept; authors become the ghost with their GitHub name; pull requests skipped", async () => {
    vi.mocked(prisma.label.findMany).mockResolvedValueOnce([{ id: "lb-bug", name: "bug" }] as never);
    vi.mocked(prisma.milestone.findMany).mockResolvedValueOnce([{ id: "ms-2", number: 2 }] as never);
    answer([
      { number: 1, title: "Crash on start", body: "Steps…", state: "closed", user: { login: "mona" }, labels: [{ name: "bug" }, { name: "not-here" }],
        milestone: { number: 2 }, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-03T00:00:00Z", closed_at: "2025-01-02T00:00:00Z" },
      { number: 2, title: "Add a test", state: "open", user: { login: "hubot" }, pull_request: { url: "…" } },
      { number: 7, title: "Docs", body: null, state: "open", user: { login: "octocat" }, labels: [], created_at: "2025-02-01T00:00:00Z" },
    ]);
    // Page 1 first raises the counter past GitHub's newest number.
    answer([{ number: 9 }]);
    await importStep(job({ stage: "issues" }), source, "ghost-id");

    const created = ops("issue.create").map((o) => o.args.data!);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      repoId: "repo-1", number: 1, title: "Crash on start", body: "Steps…", state: "CLOSED",
      closedAt: new Date("2025-01-02T00:00:00Z"), createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: new Date("2025-01-03T00:00:00Z"),
      authorId: "ghost-id", importedAuthor: "mona", milestoneId: "ms-2", labels: { create: [{ labelId: "lb-bug" }] },
    });
    expect(created[1]).toMatchObject({ number: 7, state: "OPEN", closedAt: null, importedAuthor: "octocat", milestoneId: null, body: null });
    // The counter: GitHub's newest (9) first, then the page's highest, the pull request's #2 included.
    expect(vi.mocked(prisma.repo.updateMany).mock.calls[0]![0]).toEqual({ where: { id: "repo-1", lastNumber: { lt: 9 } }, data: { lastNumber: 9 } });
    expect(ops("repo.updateMany")[0]!.args).toEqual({ where: { id: "repo-1", lastNumber: { lt: 7 } }, data: { lastNumber: 7 } });
    expect(cursor()).toEqual({ stage: "pulls", page: 1, issues: { increment: 2 } });
  });

  it("issues: a page done before a restart isn't doubled", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValueOnce([{ number: 1 }] as never);
    answer([{ number: 1, title: "Crash on start", state: "open" }]);
    await importStep(job({ stage: "issues", page: 2 }), source, "ghost-id");
    expect(ops("issue.create")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no reservation after page 1
  });

  it("comments: to the issue or pull request they were on, by the ghost with their GitHub name", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValueOnce([{ id: "is-1", number: 1 }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([{ id: "pr-2", number: 2 }] as never);
    answer([
      { body: "Same here", user: { login: "mona" }, created_at: "2025-01-01T10:00:00Z", issue_url: "https://api.github.com/repos/octocat/Hello-World/issues/1" },
      { body: "LGTM", user: { login: "hubot" }, created_at: "2025-01-02T10:00:00Z", issue_url: "https://api.github.com/repos/octocat/Hello-World/issues/2" },
      { body: "On something not here", user: { login: "x" }, issue_url: "https://api.github.com/repos/octocat/Hello-World/issues/99" },
    ]);
    await importStep(job({ stage: "comments" }), source, "ghost-id");
    expect(ops("issueComment.create").map((o) => o.args.data!)).toEqual([
      { issueId: "is-1", authorId: "ghost-id", importedAuthor: "mona", body: "Same here", createdAt: new Date("2025-01-01T10:00:00Z"), updatedAt: new Date("2025-01-01T10:00:00Z") },
    ]);
    expect(ops("pullRequestComment.create").map((o) => o.args.data!)).toEqual([
      { pullRequestId: "pr-2", authorId: "ghost-id", importedAuthor: "hubot", body: "LGTM", createdAt: new Date("2025-01-02T10:00:00Z"), updatedAt: new Date("2025-01-02T10:00:00Z") },
    ]);
    expect(cursor()).toEqual({ stage: "done", page: 1, comments: { increment: 2 } });
  });

  describe("pulls", () => {
    const H = (c: string) => c.repeat(40);
    const BASE = H("b");
    /** A repository with these commits and branches; merge-base answers BASE. */
    function repoHas(commits: string[], branches: Record<string, string>) {
      const made: string[][] = [];
      vi.mocked(git).mockImplementation((async (_key: string, args: string[]) => {
        const [cmd, ...rest] = args;
        if (cmd === "rev-parse") {
          const rev = rest.at(-1)!;
          if (rev.startsWith("refs/heads/")) {
            const b = branches[rev.slice("refs/heads/".length)];
            if (b) return b;
            throw new Error("no such branch");
          }
          const c = rev.replace("^{commit}", "");
          if (commits.includes(c)) return c;
          throw new Error("no such commit");
        }
        if (cmd === "merge-base") return BASE;
        if (cmd === "check-ref-format") return rest.at(-1)!;
        if (cmd === "update-ref") {
          made.push(rest);
          return "";
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      }) as never);
      return made;
    }
    const fetchHeads = vi.fn().mockResolvedValue(undefined);
    const pull = (o: Record<string, unknown>) => ({
      title: "A change", state: "closed", user: { login: "mona" }, created_at: "2025-01-01T00:00:00Z",
      head: { ref: "feature", sha: H("1"), repo: { full_name: "octocat/Hello-World", owner: { login: "octocat" } } },
      base: { ref: "main", sha: H("0") }, ...o,
    });

    it("page 1 fetches every pull request's head first; closed and merged ones record the commits they span", async () => {
      repoHas([H("1"), H("2"), H("9")], {});
      answer([
        pull({ number: 4, merged_at: "2025-01-03T00:00:00Z", merge_commit_sha: H("9"), labels: [{ name: "bug" }] }),
        pull({ number: 5, head: { ref: "gone", sha: H("2"), repo: null } }),
      ]);
      vi.mocked(prisma.label.findMany).mockResolvedValueOnce([{ id: "lb-bug", name: "bug" }] as never);
      await importStep(job({ stage: "pulls" }), source, "ghost-id", fetchHeads);
      expect(fetchHeads).toHaveBeenCalledWith("ada/hello.git", source);
      const [merged, closed] = ops("pullRequest.create").map((o) => o.args.data!);
      expect(merged).toMatchObject({
        repoId: "repo-1", number: 4, state: "MERGED", fromBranch: "feature", toBranch: "main", mergedAt: new Date("2025-01-03T00:00:00Z"),
        mergeCommitSha: H("9"), baseSha: BASE, headSha: H("1"), authorId: "ghost-id", importedAuthor: "mona", isDraft: false,
        labels: { create: [{ labelId: "lb-bug" }] },
      });
      expect(closed).toMatchObject({ number: 5, state: "CLOSED", fromBranch: "gone", mergedAt: null, mergeCommitSha: null, baseSha: BASE, headSha: H("2") });
      expect(cursor()).toEqual({ stage: "comments", page: 1, pulls: { increment: 2 } });
      expect(ops("repo.updateMany")[0]!.args).toEqual({ where: { id: "repo-1", lastNumber: { lt: 5 } }, data: { lastNumber: 5 } });
    });

    it("an open one reads its own branch; one from a fork gets github/fork/<owner>/<number>/<branch>", async () => {
      const made = repoHas([H("1"), H("3")], { feature: H("1") });
      answer([
        pull({ number: 6, state: "open", draft: true }),
        pull({ number: 7, state: "open", head: { ref: "fix-typo", sha: H("3"), repo: { full_name: "mona/Hello-World", owner: { login: "mona" } } } }),
      ]);
      await importStep(job({ stage: "pulls", page: 2 }), source, "ghost-id", fetchHeads);
      expect(fetchHeads).not.toHaveBeenCalled(); // only on page 1
      const [own, fork] = ops("pullRequest.create").map((o) => o.args.data!);
      expect(own).toMatchObject({ number: 6, state: "OPEN", isDraft: true, fromBranch: "feature", baseSha: null, headSha: null });
      expect(fork).toMatchObject({ number: 7, state: "OPEN", fromBranch: "github/fork/mona/7/fix-typo", baseSha: null, headSha: null });
      expect(made).toEqual([["refs/heads/github/fork/mona/7/fix-typo", H("3"), ""]]);
    });

    it("an open one whose commits GitHub didn't give comes over closed; a number already here is skipped", async () => {
      repoHas([], {});
      vi.mocked(prisma.issue.findMany).mockResolvedValueOnce([{ number: 8 }] as never);
      answer([
        pull({ number: 8, state: "open" }),
        pull({ number: 9, state: "open", head: { ref: "x", sha: H("4"), repo: { full_name: "mona/Hello-World", owner: { login: "mona" } } } }),
      ]);
      await importStep(job({ stage: "pulls", page: 2 }), source, "ghost-id", fetchHeads);
      const created = ops("pullRequest.create").map((o) => o.args.data!);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ number: 9, state: "CLOSED", fromBranch: "x", baseSha: null, headSha: null });
    });

    it("a failed fetch of the heads stops the step with a plain message", async () => {
      await expect(importStep(job({ stage: "pulls" }), source, "ghost-id", vi.fn().mockRejectedValue(new Error("fatal: …/srv/git")))).rejects.toThrow(
        new GithubFailed("Could not fetch the pull requests' commits from GitHub"),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("an answer that isn't a list stops the step", async () => {
    answer({ message: "Moved Permanently" });
    await expect(importStep(job(), source, "ghost-id")).rejects.toBeInstanceOf(GithubFailed);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("runIssueImport", () => {
  const app = { log: { warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
  const withRepo = (j: GithubIssueImport) => ({ ...j, repo: { importSource: "octocat/Hello-World" } });

  it("steps through to done", async () => {
    vi.mocked(prisma.githubIssueImport.findUnique)
      .mockResolvedValueOnce(withRepo(job({ stage: "comments" })) as never)
      .mockResolvedValueOnce(withRepo(job({ stage: "done" })) as never);
    answer([]);
    await runIssueImport(app, "repo-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses at GitHub's limit, recording when it carries on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValueOnce(withRepo(job({ stage: "issues" })) as never);
      answer({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795150000" });
      await runIssueImport(app, "repo-1");
      expect(prisma.githubIssueImport.updateMany).toHaveBeenCalledWith({ where: { repoId: "repo-1" }, data: { waitUntil: new Date(1795150000 * 1000) } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after three failures in a row, with a message an admin can act on", async () => {
    vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValue(withRepo(job({ stage: "labels" })) as never);
    for (let i = 0; i < 3; i++) answer({ message: "Server Error" }, 502);
    await runIssueImport(app, "repo-1", async () => undefined);
    expect(prisma.githubIssueImport.updateMany).toHaveBeenCalledWith({ where: { repoId: "repo-1" }, data: { error: "GitHub answered 502. Try again later." } });
  });

  it("does nothing for a job that stopped, finished, or is gone", async () => {
    vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValueOnce(withRepo(job({ error: "GitHub answered 502. Try again later." })) as never);
    await runIssueImport(app, "repo-1");
    vi.mocked(prisma.githubIssueImport.findUnique).mockResolvedValueOnce(null);
    await runIssueImport(app, "repo-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
