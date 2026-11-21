import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { bareRepoPathFromKey } from "./git-storage.js";
import { branchExists, setDefaultBranch } from "./git-utils.js";
import { runPostReceiveEffects } from "./git-push-shared.js";
import { prisma } from "./prisma.js";
import { handleSchema, topicSchema } from "./validation.js";

const execFile = promisify(execFileCb);

// Import a public GitHub repository (#289), phase 1: branches, tags, default branch, description, topics.

/** Checked against GitHub's `size` (KB) before downloading: GitHub asks repositories to stay under 1 GB (#289). */
export const MAX_IMPORT_KB = 1024 * 1024;

/** A fetch running longer is stopped, so an import never stays "importing" for good (#289). */
const FETCH_TIMEOUT_MS = 30 * 60 * 1000;

/** An import refused before it starts: the HTTP status to answer and a message for the person. */
export class ImportError extends Error {
  /** When the server's hourly GitHub requests are used up: when they come back. */
  constructor(readonly status: number, message: string, readonly resetAt: Date | null = null) {
    super(message);
  }
}

/** GitHub's repository-name characters. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `https://github.com/<owner>/<name>[.git][/]` or `<owner>/<name>`; only the validated parts ever reach git (#289). */
export function parseGithubRepo(input: string): { owner: string; name: string } | null {
  const m = /^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) return null;
  const [, owner, name] = m as unknown as [string, string, string];
  if (!handleSchema.safeParse(owner).success) return null;
  if (!REPO_NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/** What an import takes from GitHub's API. */
export type GithubRepo = {
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  defaultBranch: string | null;
};

/**
 * The server's optional GitHub token. GitHub's API allows 60 requests an hour per server address
 * without one, 5,000 with one; each import or retry asks once. Only that request carries it:
 * the git fetch never does, and a private repository is refused either way.
 */
export function githubToken(): string | null {
  return process.env["FORGEHUB_GITHUB_TOKEN"]?.trim() || null;
}

/** "Try again in 12 minutes", from GitHub's `x-ratelimit-reset` (seconds since the epoch). */
function tryAgain(reset: string | null): string {
  const ms = Number(reset) * 1000 - Date.now();
  if (!reset || !Number.isFinite(ms)) return "Try again later.";
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * One request to GitHub's API as this server, with its token when it has one; throws
 * {@link ImportError} for anything but an answer to read (#289, #308).
 */
async function githubApi(path: string, notFound: ImportError): Promise<unknown> {
  const token = githubToken();
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ForgeHub",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImportError(502, "Could not reach GitHub. Try again later.");
  }
  // Asked without a token, GitHub answers a private repository with 404 too.
  if (res.status === 404) throw notFound;
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const limit = Number(res.headers.get("x-ratelimit-limit")) || (token ? 5000 : 60);
      const reset = res.headers.get("x-ratelimit-reset");
      const resetAt = Number.isFinite(Number(reset)) && reset ? new Date(Number(reset) * 1000) : new Date(Date.now() + 60 * 60_000);
      throw new ImportError(
        503,
        `This server has used up its ${limit.toLocaleString("en-US")} GitHub requests for the hour. ${tryAgain(reset)}`,
        resetAt,
      );
    }
    // A revoked or expired token fails every import, public repositories included.
    if (res.status === 401 && token) {
      throw new ImportError(502, "GitHub refused this server's token. Ask the server's administrator to replace it.");
    }
    throw new ImportError(502, `GitHub answered ${res.status}. Try again later.`);
  }
  return res.json().catch(() => null);
}

/** A public repository's metadata; throws {@link ImportError} for what can't be imported (#289). */
export async function fetchGithubRepo(owner: string, name: string): Promise<GithubRepo> {
  const where = `github.com/${owner}/${name}`;
  const notPublic = new ImportError(404, `There is no public repository at ${where}. Only public repositories can be imported.`);
  const body = (await githubApi(`/repos/${owner}/${name}`, notPublic)) as {
    full_name?: unknown; private?: unknown; size?: unknown; description?: unknown; topics?: unknown; default_branch?: unknown;
  } | null;
  // With a token, a private repository its owner can see answers 200: refused the same way.
  if (body?.private !== false) throw notPublic;
  const canonical = parseGithubRepo(String(body.full_name ?? ""));
  if (!canonical || typeof body.size !== "number") throw new ImportError(502, "GitHub sent an unexpected answer. Try again later.");
  if (body.size > MAX_IMPORT_KB) {
    throw new ImportError(413, `${where} is ${Math.round(body.size / 1024)} MB; repositories up to 1 GB can be imported.`);
  }
  return {
    // The current name: a renamed repository is fetched where it now lives, no redirect needed.
    ...canonical,
    description: typeof body.description === "string" ? body.description.trim().slice(0, 2000) || null : null,
    topics: (Array.isArray(body.topics) ? body.topics : [])
      .filter((t): t is string => topicSchema.safeParse(t).success)
      .slice(0, 20),
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : null,
  };
}

/** An organization's repositories are listed up to this many pages of 100 (#308). */
export const MAX_ORG_REPO_PAGES = 10;

/** `https://github.com/<org>[/]` or `<org>` (#308). */
export function parseGithubOrg(input: string): string | null {
  const m = /^(?:https:\/\/github\.com\/)?([^/]+?)\/?$/.exec(input.trim());
  return m && handleSchema.safeParse(m[1]).success ? m[1]! : null;
}

/** A repository in an organization's list, as the person picks which to bring (#308). */
export type GithubOrgRepo = { name: string; description: string | null; sizeKb: number; fork: boolean; archived: boolean };

/** What an organization import takes from GitHub's API (#308). */
export type GithubOrg = {
  login: string;
  displayName: string | null;
  description: string | null;
  repos: GithubOrgRepo[];
  /** More than {@link MAX_ORG_REPO_PAGES} pages: the rest aren't listed. */
  truncated: boolean;
};

const unexpected = () => new ImportError(502, "GitHub sent an unexpected answer. Try again later.");
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);

/**
 * A GitHub organization and its public repositories (#308): one request for the
 * organization and one per 100 repositories. Throws {@link ImportError}.
 */
export async function fetchGithubOrg(login: string): Promise<GithubOrg> {
  const notFound = new ImportError(404, `There is no GitHub organization named ${login}.`);
  const org = (await githubApi(`/orgs/${login}`, notFound)) as { login?: unknown; name?: unknown; description?: unknown } | null;
  if (typeof org?.login !== "string" || !handleSchema.safeParse(org.login).success) throw unexpected();
  const repos: GithubOrgRepo[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const list = await githubApi(`/orgs/${org.login}/repos?type=public&sort=full_name&per_page=100&page=${page}`, notFound);
    if (!Array.isArray(list)) throw unexpected();
    for (const r of list as Array<Record<string, unknown> | null>) {
      // With a token, an organization's private repositories can be listed too: never offered.
      if (r?.private !== false || typeof r.name !== "string" || !REPO_NAME.test(r.name) || typeof r.size !== "number") continue;
      repos.push({
        name: r.name,
        description: text(r.description, 2000),
        sizeKb: r.size,
        fork: r.fork === true,
        archived: r.archived === true,
      });
    }
    if (list.length < 100) break;
    if (page === MAX_ORG_REPO_PAGES) {
      truncated = true;
      break;
    }
  }
  return { login: org.login, displayName: text(org.name, 120), description: text(org.description, 2000), repos, truncated };
}

/** git doesn't read it, but nothing git starts gets the server's token either. */
function withoutGithubToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { FORGEHUB_GITHUB_TOKEN: _token, ...rest } = env;
  return rest;
}

/** A fetch from a public GitHub repository: no credentials offered, no redirects, https only, never interactive. */
async function fetchRefs(storageKey: string, source: { owner: string; name: string }, flags: string[], refspecs: string[]): Promise<void> {
  const dir = bareRepoPathFromKey(storageKey);
  await execFile(
    "git",
    [
      "--git-dir", dir,
      // A public repository needs no credentials, so none of the server's are offered.
      "-c", "credential.helper=",
      "-c", "http.followRedirects=false",
      "fetch", ...flags, "--no-tags", "--quiet", "--",
      `https://github.com/${source.owner}/${source.name}.git`,
      ...refspecs,
    ],
    {
      cwd: dir,
      timeout: FETCH_TIMEOUT_MS,
      env: { ...withoutGithubToken(process.env), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https" },
    },
  );
}

/** Branches and tags only, atomic and never forced: all refs land or none, and none already there moves (#289). */
async function fetchFromGithub(storageKey: string, source: { owner: string; name: string }): Promise<void> {
  await fetchRefs(storageKey, source, ["--atomic"], ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]);
}

/**
 * Every pull request's head, as GitHub keeps it, into refs/pull/<n>/head (#289, phase 3):
 * the commits of pull requests from forks or with deleted branches live nowhere else.
 * Forced, since a pull request's head moves when it's pushed to; ForgeHub keeps none of
 * its own refs there.
 */
export async function fetchPullHeads(storageKey: string, source: { owner: string; name: string }): Promise<void> {
  await fetchRefs(storageKey, source, [], ["+refs/pull/*/head:refs/pull/*/head"]);
}

/** The background job; never throws, a failure is recorded for the repository's page to offer Retry (#289). */
export async function runGithubImport(
  app: FastifyInstance,
  repo: { id: string; storageKey: string },
  actorId: string,
  source: GithubRepo,
): Promise<void> {
  const from = `github.com/${source.owner}/${source.name}`;
  try {
    await fetchFromGithub(repo.storageKey, source);
    if (source.defaultBranch && (await branchExists(repo.storageKey, source.defaultBranch))) {
      await setDefaultBranch(repo.storageKey, source.defaultBranch);
    }
  } catch (err) {
    app.log.error({ err }, `importing ${from} failed`);
    // git's own message names server paths, so the person gets a plain one.
    const importError = (err as { killed?: boolean }).killed
      ? `Fetching ${from} took longer than 30 minutes.`
      : `Could not fetch ${from}. It may have been deleted, made private, or changed during the import.`;
    await prisma.repo
      .update({ where: { id: repo.id }, data: { importStatus: "failed", importError } })
      .catch(() => {}); // deleted meanwhile
    return;
  }
  try {
    await prisma.repo.update({ where: { id: repo.id }, data: { importStatus: null, importError: null } });
    // The first refs count as a push: ingestion, formats, activity, webhooks, CI.
    await runPostReceiveEffects(app, repo, actorId, bareRepoPathFromKey(repo.storageKey), new Map());
  } catch (err) {
    app.log.error({ err }, `finishing the import of ${from} failed`);
  }
}

/** A restart ends any running fetch: mark its import failed so it can be retried, as ci/boot.ts does for runs (#289). */
export async function failInterruptedImports(): Promise<number> {
  const { count } = await prisma.repo.updateMany({
    where: { importStatus: "importing" },
    data: { importStatus: "failed", importError: "The server restarted during the import." },
  });
  return count;
}
