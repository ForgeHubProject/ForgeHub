import type { FastifyInstance } from "fastify";
import type { GithubIssueImport, Prisma } from "@prisma/client";
import { fetchPullHeads, githubToken, parseGithubRepo } from "./github-import.js";
import { git } from "./git-utils.js";
import { ghostUser } from "./ghost.js";
import { prisma } from "./prisma.js";

/*
 * GitHub import, phases 2 and 3 (#289): after the git history, the repository's
 * labels, milestones, issues, pull requests, and the comments on both.
 *
 * One page of GitHub's listing per step, written in one transaction together with
 * the job's cursor, so a page lands whole or not at all and a restart carries on
 * where it stopped. GitHub's hourly limit only pauses it until the reset.
 *
 * Issues and pull requests keep their GitHub numbers: they share one sequence here
 * as there (#259), and the repository's counter is raised past every number GitHub
 * has used, so nothing made here meanwhile takes one. A closed or merged pull
 * request records the commits it spans (pull-range.ts), so it needs no branch; its
 * head comes from GitHub's refs/pull/<n>/head. An open one from a fork gets a branch,
 * named as GitLab's GitHub importer names them: github/fork/<owner>/<number>/<branch>.
 *
 * Authors have no account here: what they wrote belongs to the ghost, with their
 * GitHub username kept beside it (`importedAuthor`).
 */

export const PER_PAGE = 100;
export type Stage = "labels" | "milestones" | "issues" | "pulls" | "comments" | "done";
const NEXT: Record<Exclude<Stage, "done">, Stage> = {
  labels: "milestones", milestones: "issues", issues: "pulls", pulls: "comments", comments: "done",
};

/** GitHub's requests for the hour are used up; carry on at `resetAt`. */
export class GithubRateLimited extends Error {
  constructor(readonly resetAt: Date) {
    super("GitHub's request limit for the hour is used up");
  }
}

/** GitHub couldn't be asked, or said no: the message is shown to the repository's admins. */
export class GithubFailed extends Error {}

/** A GET to GitHub's API, with the server's token when it has one. */
export async function githubGet(path: string): Promise<unknown> {
  const token = githubToken();
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ForgeHub",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GithubFailed("Could not reach GitHub");
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      throw new GithubRateLimited(new Date(reset > 0 ? reset * 1000 : Date.now() + 60 * 60_000));
    }
    // GitHub's secondary limits say how long to wait instead.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) throw new GithubRateLimited(new Date(Date.now() + retryAfter * 1000));
  }
  if (res.status === 401 && token) throw new GithubFailed("GitHub refused this server's token");
  if (!res.ok) throw new GithubFailed(`GitHub answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new GithubFailed("GitHub sent an unexpected answer");
  }
}

// What each listing gives that an import keeps. Everything is checked: it comes off the network.
type GhUser = { login?: unknown } | null | undefined;
type GhLabel = { name?: unknown; color?: unknown; description?: unknown };
type GhMilestone = {
  number?: unknown; title?: unknown; description?: unknown; state?: unknown;
  due_on?: unknown; closed_at?: unknown; created_at?: unknown; updated_at?: unknown;
};
type GhIssue = {
  number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: GhUser;
  labels?: unknown; milestone?: { number?: unknown } | null;
  created_at?: unknown; updated_at?: unknown; closed_at?: unknown; pull_request?: unknown;
};
type GhComment = { body?: unknown; user?: GhUser; created_at?: unknown; updated_at?: unknown; issue_url?: unknown };

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const date = (v: unknown): Date | undefined => {
  const d = typeof v === "string" ? new Date(v) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const login = (u: GhUser): string | null => text(u?.login, 39);
const list = <T>(v: unknown): T[] => {
  if (!Array.isArray(v)) throw new GithubFailed("GitHub sent an unexpected answer");
  return v as T[];
};

/** `…/repos/o/n/issues/123` → 123. */
export function issueNumberFromUrl(url: unknown): number | null {
  const m = typeof url === "string" ? /\/issues\/(\d+)$/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

/** The job's cursor after a page of `n` items: the next page, or the next stage's first. */
function advance(
  job: GithubIssueImport, n: number, counts: { issues?: number; pulls?: number; comments?: number } = {},
): Prisma.PrismaPromise<unknown> {
  const stage = job.stage as Exclude<Stage, "done">;
  return prisma.githubIssueImport.update({
    where: { repoId: job.repoId },
    data: {
      ...(n < PER_PAGE ? { stage: NEXT[stage], page: 1 } : { page: job.page + 1 }),
      ...(counts.issues ? { issues: { increment: counts.issues } } : {}),
      ...(counts.pulls ? { pulls: { increment: counts.pulls } } : {}),
      ...(counts.comments ? { comments: { increment: counts.comments } } : {}),
    },
  });
}

/** One page of the job's current stage, written with the cursor in one transaction. */
export async function importStep(
  job: GithubIssueImport,
  source: { owner: string; name: string },
  ghostId: string,
  fetchHeads: typeof fetchPullHeads = fetchPullHeads,
): Promise<void> {
  const repoId = job.repoId;
  const at = `/repos/${source.owner}/${source.name}`;
  const page = `per_page=${PER_PAGE}&page=${job.page}`;

  if (job.stage === "labels") {
    const items = list<GhLabel>(await githubGet(`${at}/labels?${page}`));
    const ops = items.flatMap((l) => {
      const name = text(l.name, 50);
      const color = typeof l.color === "string" && /^[0-9a-fA-F]{6}$/.test(l.color) ? l.color.toLowerCase() : "ededed";
      if (!name) return [];
      const description = text(l.description, 100);
      // GitHub's colour and description win over a label of the same name already here.
      return [prisma.label.upsert({ where: { repoId_name: { repoId, name } }, create: { repoId, name, color, description }, update: { color, description } })];
    });
    await prisma.$transaction([...ops, advance(job, items.length)]);
    return;
  }

  if (job.stage === "milestones") {
    const items = list<GhMilestone>(await githubGet(`${at}/milestones?state=all&${page}`));
    const taken = new Set(
      (await prisma.milestone.findMany({ where: { repoId }, select: { title: true } })).map((m) => m.title),
    );
    const ops = items.flatMap((m) => {
      const number = count(m.number);
      const title = text(m.title, 255);
      if (!number || !title || taken.has(title)) return [];
      taken.add(title);
      const closed = m.state === "closed";
      const data = {
        title,
        description: text(m.description, 65_536),
        dueOn: date(m.due_on) ?? null,
        state: closed ? ("CLOSED" as const) : ("OPEN" as const),
        closedAt: closed ? date(m.closed_at) ?? new Date() : null,
      };
      return [prisma.milestone.upsert({
        where: { repoId_number: { repoId, number } },
        create: { repoId, number, ...data, createdAt: date(m.created_at), updatedAt: date(m.updated_at) },
        update: {},
      })];
    });
    await prisma.$transaction([...ops, advance(job, items.length)]);
    return;
  }

  if (job.stage === "issues") {
    // GitHub's issues listing has its pull requests in it too: they keep their numbers free.
    const items = list<GhIssue>(await githubGet(`${at}/issues?state=all&sort=created&direction=asc&${page}`));
    if (job.page === 1) await reserveNumbers(repoId, at);
    const issues = items.filter((i) => i.pull_request == null && count(i.number) && text(i.title, 1));
    const numbers = issues.map((i) => count(i.number)!);
    const [labels, milestones, existing, pulls] = await Promise.all([
      prisma.label.findMany({ where: { repoId }, select: { id: true, name: true } }),
      prisma.milestone.findMany({ where: { repoId }, select: { id: true, number: true } }),
      prisma.issue.findMany({ where: { repoId, number: { in: numbers } }, select: { number: true } }),
      prisma.pullRequest.findMany({ where: { repoId, number: { in: numbers } }, select: { number: true } }),
    ]);
    const labelId = new Map(labels.map((l) => [l.name, l.id]));
    const milestoneId = new Map(milestones.map((m) => [m.number, m.id]));
    // A page done before a restart, or a number taken here meanwhile, is skipped rather than doubled.
    const skip = new Set([...existing, ...pulls].map((x) => x.number));
    const ops = issues.flatMap((i) => {
      const number = count(i.number)!;
      if (skip.has(number)) return [];
      const names = (Array.isArray(i.labels) ? i.labels : [])
        .map((l) => text(typeof l === "string" ? l : (l as GhLabel | null)?.name, 50))
        .filter((n): n is string => !!n && labelId.has(n));
      const closed = i.state === "closed";
      const createdAt = date(i.created_at);
      return [prisma.issue.create({
        data: {
          repoId,
          number,
          title: text(i.title, 256)!,
          body: text(i.body, 262_144),
          state: closed ? "CLOSED" : "OPEN",
          closedAt: closed ? date(i.closed_at) ?? createdAt ?? new Date() : null,
          createdAt,
          updatedAt: date(i.updated_at) ?? createdAt,
          authorId: ghostId,
          importedAuthor: login(i.user),
          milestoneId: milestoneId.get(count(i.milestone?.number) ?? -1) ?? null,
          labels: { create: [...new Set(names)].map((n) => ({ labelId: labelId.get(n)! })) },
        },
      })];
    });
    // Every number on the page, pull requests' too, stays above the counter.
    const highest = Math.max(0, ...items.map((i) => count(i.number) ?? 0));
    await prisma.$transaction([
      ...ops,
      prisma.repo.updateMany({ where: { id: repoId, lastNumber: { lt: highest } }, data: { lastNumber: highest } }),
      advance(job, items.length, { issues: ops.length }),
    ]);
    return;
  }

  if (job.stage === "pulls") {
    await importPulls(job, source, ghostId, `${at}/pulls?state=all&sort=created&direction=asc&${page}`, fetchHeads);
    return;
  }

  if (job.stage === "comments") {
    // One listing for the whole repository, issues' and pull requests' conversations
    // alike: far fewer requests than one per issue.
    const items = list<GhComment>(await githubGet(`${at}/issues/comments?sort=created&direction=asc&${page}`));
    const numbers = [...new Set(items.map((c) => issueNumberFromUrl(c.issue_url)).filter((n): n is number => n !== null))];
    const [issues, pulls] = await Promise.all([
      prisma.issue.findMany({ where: { repoId, number: { in: numbers } }, select: { id: true, number: true } }),
      prisma.pullRequest.findMany({ where: { repoId, number: { in: numbers } }, select: { id: true, number: true } }),
    ]);
    const issueId = new Map(issues.map((i) => [i.number, i.id]));
    const pullId = new Map(pulls.map((p) => [p.number, p.id]));
    const ops = items.flatMap((c): Prisma.PrismaPromise<unknown>[] => {
      const number = issueNumberFromUrl(c.issue_url) ?? -1;
      const createdAt = date(c.created_at);
      const data = {
        authorId: ghostId,
        importedAuthor: login(c.user),
        body: typeof c.body === "string" ? c.body.slice(0, 262_144) : "",
        createdAt,
        updatedAt: date(c.updated_at) ?? createdAt,
      };
      const issue = issueId.get(number);
      if (issue) return [prisma.issueComment.create({ data: { issueId: issue, ...data } })];
      const pull = pullId.get(number);
      if (pull) return [prisma.pullRequestComment.create({ data: { pullRequestId: pull, ...data } })];
      return [];
    });
    await prisma.$transaction([...ops, advance(job, items.length, { comments: ops.length })]);
  }
}

type GhPull = GhIssue & {
  draft?: unknown; merged_at?: unknown; merge_commit_sha?: unknown;
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown; owner?: GhUser } | null } | null;
  base?: { ref?: unknown; sha?: unknown } | null;
};

const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v : null);

async function tryGit(storageKey: string, args: string[]): Promise<string | null> {
  try {
    return (await git(storageKey, args)) || null;
  } catch {
    return null;
  }
}

/** The commit, when this repository has it. */
async function commit(storageKey: string, rev: string | null): Promise<string | null> {
  return rev ? tryGit(storageKey, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) : null;
}

/**
 * The branch an open pull request from a fork reads from here: GitLab's name for it,
 * github/fork/<owner>/<number>/<branch>, made at its head (or the one a page done
 * before a restart made). Null when the name isn't a valid branch or it can't be made.
 */
async function forkBranch(storageKey: string, owner: string, number: number, ref: string, head: string): Promise<string | null> {
  const name = `github/fork/${owner}/${number}/${ref}`;
  if (!(await tryGit(storageKey, ["check-ref-format", "--branch", name]))) return null;
  if (await tryGit(storageKey, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  // "" as the old value: only if no branch has the name.
  try {
    await git(storageKey, ["update-ref", `refs/heads/${name}`, head, ""]);
    return name;
  } catch {
    return null;
  }
}

/**
 * A page of pull requests. Page 1 first fetches every pull request's head from GitHub.
 * Closed and merged ones record the commits they span: their head, and its merge base
 * with where they were going. Open ones read from their branch: their own when it's in
 * this repository, else one made for them from the fork's head.
 */
async function importPulls(
  job: GithubIssueImport, source: { owner: string; name: string }, ghostId: string, url: string,
  fetchHeads: typeof fetchPullHeads,
): Promise<void> {
  const repoId = job.repoId;
  const { storageKey } = await prisma.repo.findUniqueOrThrow({ where: { id: repoId }, select: { storageKey: true } });
  if (!storageKey) throw new GithubFailed("This repository has no git storage");
  if (job.page === 1) {
    try {
      await fetchHeads(storageKey, source);
    } catch {
      throw new GithubFailed("Could not fetch the pull requests' commits from GitHub");
    }
  }
  const items = list<GhPull>(await githubGet(url)).filter((p) => count(p.number) && text(p.title, 1));
  const numbers = items.map((p) => count(p.number)!);
  const [labels, milestones, issues, pulls] = await Promise.all([
    prisma.label.findMany({ where: { repoId }, select: { id: true, name: true } }),
    prisma.milestone.findMany({ where: { repoId }, select: { id: true, number: true } }),
    prisma.issue.findMany({ where: { repoId, number: { in: numbers } }, select: { number: true } }),
    prisma.pullRequest.findMany({ where: { repoId, number: { in: numbers } }, select: { number: true } }),
  ]);
  const labelId = new Map(labels.map((l) => [l.name, l.id]));
  const milestoneId = new Map(milestones.map((m) => [m.number, m.id]));
  const skip = new Set([...issues, ...pulls].map((x) => x.number));
  const sameRepo = `${source.owner}/${source.name}`.toLowerCase();

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const p of items) {
    const number = count(p.number)!;
    if (skip.has(number)) continue;
    const fromRef = text(p.head?.ref, 255) ?? `pull/${number}`;
    const toBranch = text(p.base?.ref, 255) ?? "main";
    const head = await commit(storageKey, sha(p.head?.sha));
    const merged = date(p.merged_at);
    let state: "OPEN" | "CLOSED" | "MERGED" = merged ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN";
    let fromBranch = fromRef;
    let range: { baseSha: string | null; headSha: string | null } = { baseSha: null, headSha: null };
    if (state === "OPEN") {
      const ownBranch = String(p.head?.repo?.full_name ?? "").toLowerCase() === sameRepo
        && (await tryGit(storageKey, ["rev-parse", "--verify", "--quiet", `refs/heads/${fromRef}`]));
      if (!ownBranch) {
        const owner = login(p.head?.repo?.owner) ?? "unknown";
        const made = head ? await forkBranch(storageKey, owner, number, fromRef, head) : null;
        // Without its commits an open pull request can't be shown: it comes over closed.
        if (made) fromBranch = made;
        else state = "CLOSED";
      }
    }
    if (state !== "OPEN" && head) {
      const base = (await tryGit(storageKey, ["merge-base", sha(p.base?.sha) ?? toBranch, head]))
        ?? (await tryGit(storageKey, ["merge-base", toBranch, head]));
      if (base) range = { baseSha: base, headSha: head };
    }
    const names = (Array.isArray(p.labels) ? p.labels : [])
      .map((l) => text(typeof l === "string" ? l : (l as GhLabel | null)?.name, 50))
      .filter((n): n is string => !!n && labelId.has(n));
    const createdAt = date(p.created_at);
    ops.push(prisma.pullRequest.create({
      data: {
        repoId,
        number,
        title: text(p.title, 256)!,
        description: text(p.body, 262_144),
        fromBranch,
        toBranch,
        state,
        isDraft: state === "OPEN" && p.draft === true,
        mergedAt: merged ?? null,
        mergeCommitSha: merged ? await commit(storageKey, sha(p.merge_commit_sha)) : null,
        ...range,
        createdAt,
        updatedAt: date(p.updated_at) ?? createdAt,
        authorId: ghostId,
        importedAuthor: login(p.user),
        milestoneId: milestoneId.get(count(p.milestone?.number) ?? -1) ?? null,
        labels: { create: [...new Set(names)].map((n) => ({ labelId: labelId.get(n)! })) },
      },
    }));
  }
  const highest = Math.max(0, ...numbers);
  await prisma.$transaction([
    ...ops,
    prisma.repo.updateMany({ where: { id: repoId, lastNumber: { lt: highest } }, data: { lastNumber: highest } }),
    advance(job, items.length, { pulls: ops.length }),
  ]);
}

/** Raise the counter past GitHub's newest issue or pull request before the first issue lands. */
async function reserveNumbers(repoId: string, at: string): Promise<void> {
  const newest = list<GhIssue>(await githubGet(`${at}/issues?state=all&sort=created&direction=desc&per_page=1`));
  const highest = count(newest[0]?.number);
  if (highest) await prisma.repo.updateMany({ where: { id: repoId, lastNumber: { lt: highest } }, data: { lastNumber: highest } });
}

// ─── The job ──────────────────────────────────────────────────────────────────

const running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start (or carry on) a repository's issue import, unless it's already running in this process. */
export function startIssueImport(app: FastifyInstance, repoId: string): void {
  if (running.has(repoId)) return;
  running.add(repoId);
  void runIssueImport(app, repoId).finally(() => running.delete(repoId));
}

/** Try again after GitHub's limit resets. The timer never keeps the process alive. */
function resumeAt(app: FastifyInstance, repoId: string, at: Date): void {
  const ms = Math.min(Math.max(1000, at.getTime() - Date.now() + 5000), 2 ** 31 - 1);
  setTimeout(() => {
    void prisma.githubIssueImport
      .updateMany({ where: { repoId }, data: { waitUntil: null } })
      .then(() => startIssueImport(app, repoId), () => undefined);
  }, ms).unref();
}

/** Steps until done, paused, stopped, or the repository is gone. Never throws. */
export async function runIssueImport(app: FastifyInstance, repoId: string, pause: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  let failures = 0;
  try {
    const ghost = await ghostUser();
    for (;;) {
      const job = await prisma.githubIssueImport.findUnique({ where: { repoId }, include: { repo: { select: { importSource: true } } } });
      if (!job || job.stage === "done" || job.error) return;
      if (job.waitUntil && job.waitUntil > new Date()) {
        resumeAt(app, repoId, job.waitUntil);
        return;
      }
      const source = job.repo.importSource ? parseGithubRepo(job.repo.importSource) : null;
      if (!source || !ghost) {
        const error = ghost ? "This repository has no GitHub source to import from." : "The username ghost belongs to someone; it's needed for imported authors.";
        await prisma.githubIssueImport.updateMany({ where: { repoId }, data: { error } });
        return;
      }
      try {
        await importStep(job, source, ghost.id);
        failures = 0;
      } catch (err) {
        if (err instanceof GithubRateLimited) {
          await prisma.githubIssueImport.updateMany({ where: { repoId }, data: { waitUntil: err.resetAt } });
          resumeAt(app, repoId, err.resetAt);
          return;
        }
        failures += 1;
        app.log.warn({ err }, `importing issues from github.com/${source.owner}/${source.name}: attempt ${failures} failed`);
        if (failures >= 3) {
          const error = err instanceof GithubFailed ? `${err.message}. Try again later.` : "Something went wrong while bringing the issues over.";
          await prisma.githubIssueImport.updateMany({ where: { repoId }, data: { error } });
          return;
        }
        await pause(5_000 * failures * failures);
      }
    }
  } catch (err) {
    // The repository was deleted meanwhile, or the database went away: nothing to record it on.
    app.log.error({ err }, `the issue import of repository ${repoId} stopped`);
  }
}

/** At startup: carry on every issue import whose git history is in (#289). */
export async function resumeIssueImports(app: FastifyInstance): Promise<number> {
  const jobs = await prisma.githubIssueImport.findMany({
    where: { stage: { not: "done" }, error: null, repo: { importStatus: null } },
    select: { repoId: true },
  });
  for (const { repoId } of jobs) startIssueImport(app, repoId);
  return jobs.length;
}

/** After the git history is in: start the issue import if the person asked for one. */
export async function startIssueImportIfAsked(app: FastifyInstance, repoId: string): Promise<void> {
  const repo = await prisma.repo.findUnique({ where: { id: repoId }, select: { importStatus: true, issueImport: { select: { stage: true } } } });
  if (repo && repo.importStatus === null && repo.issueImport) startIssueImport(app, repoId);
}
