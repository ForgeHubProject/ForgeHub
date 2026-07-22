import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { defaultBranch, resolveRefSha } from "../git-utils.js";
import {
  buildPathspecs,
  clampLimit,
  parseCodeQuery,
  runCodeGrep,
  type CodeFileHit,
} from "../code-search.js";

function viewerId(request: { user?: { sub: string } }): string | undefined {
  return request.user?.sub;
}

// ─── global code-search bounds (v0) ─────────────────────────────────────────────
// Cross-repo search fans a bounded `git grep` across the most-recently-updated
// repos the caller can read — no external index. These caps keep a global query
// from turning into an unbounded fleet of subprocesses.
const GLOBAL_REPO_SCAN_CAP = 10; // at most N readable repos scanned per query
const PER_REPO_MATCH_CAP = 50; // match lines collected from any one repo
const GLOBAL_FILE_CAP = 200; // total file cards returned across all repos
const GLOBAL_GREP_TIMEOUT_MS = 2_000; // per-repo subprocess timebox (parallel)

type CodeResultRow = {
  repo: { ownerHandle: string; name: string };
  ref: string;
  sha: string;
  path: string;
  matches: CodeFileHit["matches"];
};

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/search",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { q, type = "repos", regex: regexQ, case: caseQ } = request.query as {
        q?: string;
        type?: string;
        regex?: string;
        case?: string;
      };

      if (!q || q.trim().length < 2) {
        return reply.status(400).send({ error: "Query must be at least 2 characters" });
      }

      const term = q.trim();
      const vid = viewerId(request as { user?: { sub: string } });

      const visibilityFilter = {
        OR: [
          { visibility: "PUBLIC" as const },
          ...(vid ? [
            { ownerId: vid },
            { collaborators: { some: { userId: vid } } },
          ] : []),
        ],
      };

      if (type === "issues") {
        const issues = await prisma.issue.findMany({
          where: {
            AND: [
              { OR: [{ title: { contains: term } }, { body: { contains: term } }] },
              { repo: visibilityFilter },
            ],
          },
          include: {
            repo: { include: { owner: { select: { handle: true } } } },
            author: { select: { handle: true, displayName: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 25,
        });

        return {
          type: "issues",
          results: issues.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            state: i.state.toLowerCase(),
            author: i.author.handle,
            createdAt: i.createdAt.toISOString(),
            updatedAt: i.updatedAt.toISOString(),
            repo: {
              name: i.repo.name,
              ownerHandle: i.repo.owner.handle,
            },
          })),
        };
      }

      if (type === "users") {
        const users = await prisma.user.findMany({
          where: {
            OR: [
              { handle: { contains: term } },
              { displayName: { contains: term } },
            ],
          },
          select: { id: true, handle: true, displayName: true, createdAt: true },
          take: 25,
        });

        return {
          type: "users",
          results: users.map((u) => ({
            id: u.id,
            handle: u.handle,
            displayName: u.displayName,
            createdAt: u.createdAt.toISOString(),
          })),
        };
      }

      // FHR entity search — the ForgeHub-native twist. Query the Entity table
      // (name/kind) across snapshots in repos the viewer can read: "every scene
      // node named landing_gear" — structural search over ingested artifacts that
      // a byte-only code search structurally cannot do.
      if (type === "entities") {
        const parsed = parseCodeQuery(term);
        const needle = parsed.text || term;

        const repoScope: Record<string, unknown> = {
          AND: [
            visibilityFilter,
            ...(parsed.repo
              ? [{ name: parsed.repo.name.toLowerCase(), owner: { handle: parsed.repo.owner.toLowerCase() } }]
              : []),
          ],
        };

        const entities = await prisma.entity.findMany({
          where: {
            AND: [
              { OR: [{ name: { contains: needle } }, { kind: { contains: needle } }] },
              { snapshot: { repo: repoScope } },
            ],
          },
          include: {
            snapshot: {
              include: { repo: { include: { owner: { select: { handle: true } } } } },
            },
          },
          orderBy: { name: "asc" },
          take: 50,
        });

        return {
          type: "entities",
          results: entities.map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            path: e.path,
            repo: {
              ownerHandle: e.snapshot.repo.owner.handle,
              name: e.snapshot.repo.name,
            },
            snapshot: {
              id: e.snapshot.id,
              sourceFile: e.snapshot.sourceFile,
              label: e.snapshot.label,
              handlerId: e.snapshot.handlerId,
              gitCommitSha: e.snapshot.gitCommitSha,
            },
          })),
        };
      }

      // Global code search — fan a bounded `git grep` across readable repos and
      // aggregate. Single-repo callers should prefer the repo-scoped endpoint
      // below; `repo:owner/name` narrows this global variant to one repo.
      if (type === "code") {
        const parsed = parseCodeQuery(term);
        const regex = regexQ === "true" || regexQ === "1";
        const caseSensitive = caseQ === "sensitive" || caseQ === "true";

        if (parsed.text.length < 1) {
          return { type: "code", results: [], truncated: false, timedOut: false, reposSearched: 0 };
        }

        const repoWhere: Record<string, unknown> = {
          AND: [
            visibilityFilter,
            { storageKey: { not: null } },
            ...(parsed.repo
              ? [{ name: parsed.repo.name.toLowerCase(), owner: { handle: parsed.repo.owner.toLowerCase() } }]
              : []),
          ],
        };

        const repos = await prisma.repo.findMany({
          where: repoWhere,
          include: { owner: { select: { handle: true } } },
          orderBy: { updatedAt: "desc" },
          take: GLOBAL_REPO_SCAN_CAP,
        });

        const pathspecs = buildPathspecs(parsed);

        // Grep every candidate repo in parallel; each subprocess is timeboxed.
        const perRepo = await Promise.all(
          repos.map(async (repo) => {
            if (!repo.storageKey) return null;
            const ref = await defaultBranch(repo.storageKey);
            const sha = await resolveRefSha(repo.storageKey, ref);
            if (!sha) return null;
            const grep = await runCodeGrep(repo.storageKey, ref, {
              pattern: parsed.text,
              regex,
              caseSensitive,
              pathspecs,
              limit: PER_REPO_MATCH_CAP,
              timeoutMs: GLOBAL_GREP_TIMEOUT_MS,
            });
            return { repo, ref, sha, grep };
          }),
        );

        const results: CodeResultRow[] = [];
        let truncated = false;
        let timedOut = false;
        for (const entry of perRepo) {
          if (!entry) continue;
          if (entry.grep.timedOut) timedOut = true;
          if (entry.grep.truncated) truncated = true;
          for (const file of entry.grep.files) {
            if (results.length >= GLOBAL_FILE_CAP) { truncated = true; break; }
            results.push({
              repo: { ownerHandle: entry.repo.owner.handle, name: entry.repo.name },
              ref: entry.ref,
              sha: entry.sha,
              path: file.path,
              matches: file.matches,
            });
          }
        }

        return { type: "code", results, truncated, timedOut, reposSearched: repos.length };
      }

      // Default: repos. `topic:<slug>` tokens filter by topic (repeatable, ANDed);
      // remaining free text still matches name/description. This is how a topic
      // chip's click-through ("topic:react") narrows to repos carrying that topic.
      const topicFilters = [...term.matchAll(/topic:([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase());
      const textTerm = term.replace(/topic:[a-z0-9-]+/gi, "").trim();

      const repoConditions: Record<string, unknown>[] = [
        visibilityFilter,
        ...topicFilters.map((topic) => ({ topics: { some: { topic } } })),
      ];
      if (textTerm.length > 0) {
        repoConditions.push({ OR: [{ name: { contains: textTerm } }, { description: { contains: textTerm } }] });
      }

      const repos = await prisma.repo.findMany({
        where: { AND: repoConditions },
        include: {
          owner: { select: { handle: true } },
          topics: { orderBy: { topic: "asc" }, select: { topic: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });

      return {
        type: "repos",
        results: repos.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          visibility: r.visibility === "PUBLIC" ? "public" : "private",
          ownerHandle: r.owner.handle,
          topics: r.topics.map((t) => t.topic),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  );

  // ─── Repo-scoped code search ───────────────────────────────────────────────
  // GET /repos/:handle/:name/code-search?q=&ref=&regex=&case=&limit=
  // `git grep` at a ref, gated by the same canRead check as blob/tree. Supports
  // the shared `path:` / `ext:` qualifiers; results deep-link to permalink line
  // anchors via the returned canonical `sha`.
  app.get(
    "/repos/:handle/:name/code-search",
    { preHandler: [app.optionalAuthenticate] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const { q, ref: refQ, regex: regexQ, case: caseQ, limit: limitQ } = request.query as {
        q?: string;
        ref?: string;
        regex?: string;
        case?: string;
        limit?: string;
      };
      const userId = (request as { user?: { sub: string } }).user?.sub;

      if (!q || q.trim().length < 2) {
        return reply.status(400).send({ error: "Query must be at least 2 characters" });
      }

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
      if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

      const parsed = parseCodeQuery(q.trim());
      if (parsed.text.length < 1) {
        return reply.status(400).send({ error: "Query must include search text, not only qualifiers" });
      }

      const ref = refQ ?? await defaultBranch(repo.storageKey);
      const sha = await resolveRefSha(repo.storageKey, ref);
      if (!sha) return reply.status(404).send({ error: "Ref not found" });

      const regex = regexQ === "true" || regexQ === "1";
      const caseSensitive = caseQ === "sensitive" || caseQ === "true";
      const limit = clampLimit(limitQ);

      const result = await runCodeGrep(repo.storageKey, ref, {
        pattern: parsed.text,
        regex,
        caseSensitive,
        pathspecs: buildPathspecs(parsed),
        limit,
      });

      return {
        query: parsed.text,
        regex,
        caseSensitive,
        ref,
        sha,
        files: result.files,
        totalMatches: result.totalMatches,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    },
  );
}
