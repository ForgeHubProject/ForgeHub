import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import type { GithubIssueImport, Prisma } from "@prisma/client";
import { buildAssetStorageKey, removeAsset, writeAssetStream } from "./git-storage.js";
import { githubToken, parseGithubRepo } from "./github-import.js";
import { ghostUser } from "./ghost.js";
import { prisma } from "./prisma.js";
import { sanitizeAssetName } from "./routes/releases.js";

/*
 * GitHub import, phase 2 (#289): after the git history, the repository's labels,
 * milestones, issues and their comments, then its releases and their files.
 *
 * One page of GitHub's listing per step, written in one transaction together with
 * the job's cursor, so a page lands whole or not at all and a restart carries on
 * where it stopped. GitHub's hourly limit only pauses it until the reset.
 *
 * Issues keep their GitHub numbers. Pull requests (and their comments) are left
 * for phase 3; since issues and pull requests share one sequence (#259), their
 * numbers stay free, and the repository's counter is raised past every number
 * GitHub has used, so nothing made here meanwhile takes one.
 *
 * Authors have no account here: what they wrote belongs to the ghost, with their
 * GitHub username kept beside it (`importedAuthor`).
 */

export const PER_PAGE = 100;
export type Stage = "labels" | "milestones" | "issues" | "comments" | "releases" | "done";
const NEXT: Record<Exclude<Stage, "done">, Stage> = {
  labels: "milestones", milestones: "issues", issues: "comments", comments: "releases", releases: "done",
};
/** Items per page of each listing. Releases come a few at a time: their files are downloaded within the step. */
export const PAGE_SIZE: Record<Exclude<Stage, "done">, number> = {
  labels: PER_PAGE, milestones: PER_PAGE, issues: PER_PAGE, comments: PER_PAGE, releases: 10,
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
  job: GithubIssueImport, n: number, counts: { issues?: number; comments?: number; releases?: number } = {},
): Prisma.PrismaPromise<unknown> {
  const stage = job.stage as Exclude<Stage, "done">;
  return prisma.githubIssueImport.update({
    where: { repoId: job.repoId },
    data: {
      ...(n < PAGE_SIZE[stage] ? { stage: NEXT[stage], page: 1 } : { page: job.page + 1 }),
      ...(counts.issues ? { issues: { increment: counts.issues } } : {}),
      ...(counts.comments ? { comments: { increment: counts.comments } } : {}),
      ...(counts.releases ? { releases: { increment: counts.releases } } : {}),
    },
  });
}

/** One page of the job's current stage, written with the cursor in one transaction. */
export async function importStep(job: GithubIssueImport, source: { owner: string; name: string }, ghostId: string): Promise<void> {
  const repoId = job.repoId;
  const at = `/repos/${source.owner}/${source.name}`;
  const page = `per_page=${PAGE_SIZE[job.stage as Exclude<Stage, "done">] ?? PER_PAGE}&page=${job.page}`;

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

  if (job.stage === "comments") {
    // One listing for the whole repository: far fewer requests than one per issue.
    const items = list<GhComment>(await githubGet(`${at}/issues/comments?sort=created&direction=asc&${page}`));
    const numbers = [...new Set(items.map((c) => issueNumberFromUrl(c.issue_url)).filter((n): n is number => n !== null))];
    const issues = await prisma.issue.findMany({ where: { repoId, number: { in: numbers } }, select: { id: true, number: true } });
    const issueId = new Map(issues.map((i) => [i.number, i.id]));
    const ops = items.flatMap((c) => {
      // A pull request's conversation: phase 3.
      const id = issueId.get(issueNumberFromUrl(c.issue_url) ?? -1);
      if (!id) return [];
      const createdAt = date(c.created_at);
      return [prisma.issueComment.create({
        data: {
          issueId: id,
          authorId: ghostId,
          importedAuthor: login(c.user),
          body: typeof c.body === "string" ? c.body.slice(0, 262_144) : "",
          createdAt,
          updatedAt: date(c.updated_at) ?? createdAt,
        },
      })];
    });
    await prisma.$transaction([...ops, advance(job, items.length, { comments: ops.length })]);
    return;
  }

  if (job.stage === "releases") await importReleases(job, source, ghostId, `${at}/releases?${page}`);
}

type GhAsset = { name?: unknown; size?: unknown; content_type?: unknown; browser_download_url?: unknown };
type GhRelease = {
  tag_name?: unknown; name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown;
  author?: GhUser; created_at?: unknown; published_at?: unknown; assets?: unknown;
};

/** The largest file a release can hold: the same cap as an upload here. */
export function maxAssetBytes(): number {
  return Number(process.env["RELEASE_ASSET_MAX_BYTES"] ?? 100 * 1024 * 1024);
}

/**
 * A release file's bytes, from GitHub's own download hosts only, streamed to storage.
 * Throws GithubFailed when GitHub won't give it, or it's bigger than `max` after all.
 */
export async function downloadAsset(url: unknown, key: string, max: number): Promise<number> {
  const from = typeof url === "string" ? new URL(url) : null;
  if (!from || from.protocol !== "https:" || from.hostname !== "github.com") throw new GithubFailed("GitHub sent an unexpected file link");
  let res: Response;
  try {
    res = await fetch(from, { headers: { "User-Agent": "ForgeHub" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new GithubFailed("Could not download a release file from GitHub");
  }
  const landed = new URL(res.url || from.href).hostname;
  if (landed !== "github.com" && !landed.endsWith(".githubusercontent.com")) throw new GithubFailed("GitHub sent a release file from an unexpected host");
  if (!res.ok || !res.body) throw new GithubFailed(`GitHub answered ${res.status} for a release file`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      done(seen > max ? new GithubFailed("A release file is bigger than GitHub said") : null, chunk);
    },
  });
  try {
    return await writeAssetStream(key, Readable.fromWeb(res.body as WebReadableStream<Uint8Array>).pipe(cap));
  } catch (err) {
    await removeAsset(key).catch(() => undefined);
    throw err instanceof GithubFailed ? err : new GithubFailed("Could not download a release file from GitHub");
  }
}

/**
 * A page of releases: each one's files are downloaded first, then every release on the
 * page is written with the cursor in one transaction. Files over the cap stay on GitHub,
 * and the release's notes say so. A release already here (a page done before a restart)
 * is skipped; drafts aren't listed without the owner's token anyway.
 */
async function importReleases(job: GithubIssueImport, source: { owner: string; name: string }, ghostId: string, url: string): Promise<void> {
  const repoId = job.repoId;
  const items = list<GhRelease>(await githubGet(url));
  const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId }, select: { storageKey: true } });
  const tags = items.map((r) => text(r.tag_name, 255)).filter((t): t is string => !!t);
  const existing = new Set((await prisma.release.findMany({ where: { repoId, tagName: { in: tags } }, select: { tagName: true } })).map((r) => r.tagName));
  const max = maxAssetBytes();
  const stored: string[] = [];
  try {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const r of items) {
      const tagName = text(r.tag_name, 255);
      if (!tagName || r.draft === true || existing.has(tagName)) continue;
      existing.add(tagName);
      const id = randomUUID();
      const assets: Prisma.ReleaseAssetCreateWithoutReleaseInput[] = [];
      const leftOnGithub: string[] = [];
      const names = new Set<string>();
      for (const a of Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []) {
        const name = sanitizeAssetName(typeof a.name === "string" ? a.name : null);
        const size = typeof a.size === "number" ? a.size : Number.POSITIVE_INFINITY;
        if (!name || names.has(name)) continue;
        if (size > max) {
          leftOnGithub.push(name);
          continue;
        }
        names.add(name);
        const storageKey = buildAssetStorageKey(repo.storageKey ?? repoId, id, name);
        stored.push(storageKey);
        const written = await downloadAsset(a.browser_download_url, storageKey, max);
        assets.push({
          name, size: written, storageKey,
          contentType: text(a.content_type, 255) ?? "application/octet-stream",
          uploadedBy: { connect: { id: ghostId } },
        });
      }
      const body = text(r.body, 262_144);
      const note = leftOnGithub.length
        ? `\n\n---\n${leftOnGithub.length === 1 ? "This file was" : "These files were"} too big to bring over and ${leftOnGithub.length === 1 ? "is" : "are"} still on GitHub: ${leftOnGithub.map((n) => `\`${n}\``).join(", ")}.`
        : "";
      const when = date(r.published_at) ?? date(r.created_at);
      ops.push(prisma.release.create({
        data: {
          id, repoId, tagName,
          name: text(r.name, 255) ?? tagName,
          body: body || note ? `${body ?? ""}${note}`.trim() : null,
          isPrerelease: r.prerelease === true,
          authorId: ghostId,
          importedAuthor: login(r.author),
          createdAt: when,
          updatedAt: when,
          assets: { create: assets },
        },
      }));
    }
    await prisma.$transaction([...ops, advance(job, items.length, { releases: ops.length })]);
  } catch (err) {
    // Nothing of this page was written: its files go too, and the page is tried again.
    await Promise.all(stored.map((k) => removeAsset(k).catch(() => undefined)));
    throw err;
  }
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
