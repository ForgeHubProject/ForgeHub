import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude, resolveRepo } from "../repo-access.js";
import { fromDbWatchLevel, toDbWatchLevel, type ApiWatchLevel } from "../watch-service.js";
import { setWatchBodySchema } from "../validation.js";
import { repoResponse } from "./repos.js";

function viewerId(request: { user?: { sub: string } }): string | undefined {
  return request.user?.sub;
}

/**
 * The watch level a repo member falls back to without an explicit row: owners
 * and direct collaborators implicitly watch ALL (issue #88); everyone else is
 * effectively PARTICIPATING — the direct reasons (mentioned / assigned /
 * review-requested) always notify, subscription or not.
 */
function defaultWatchLevel(
  repo: { ownerId: string; collaborators: Array<{ userId: string }> },
  userId: string,
): ApiWatchLevel {
  const isMember = repo.ownerId === userId || repo.collaborators.some((c) => c.userId === userId);
  return isMember ? "all" : "participating";
}

// ─── Feed source (issue #88) ─────────────────────────────────────────────────────
// The feed is pure READS over what earlier issues already persist — no third
// event pipeline: openings come straight from Issue/PullRequest rows, releases
// from Release rows, and state changes from the conversation spine's
// TimelineEvent (#80). Only the terminal state-change kinds surface here — label
// churn, milestone moves, pin/lock etc. are conversation detail, not home-feed
// material. `emitRepoEvent` (#87) stays a fire-and-forget webhook delivery path;
// persisting from it would just duplicate the spine.
const FEED_TIMELINE_KINDS = ["closed", "reopened", "merged"] as const;

/** One wire-format feed entry; `type` discriminates the per-source fields. */
type FeedItem = {
  type: "issue_opened" | "pr_opened" | "release" | "timeline";
  id: string;
  repo: { ownerHandle: string; name: string };
  actor: string;
  createdAt: string;
  /** issue_opened / pr_opened / timeline */
  number?: number;
  title?: string;
  /** timeline */
  kind?: string;
  subjectType?: "issue" | "pull_request";
  /** release */
  tagName?: string;
  releaseName?: string;
};

export async function socialRoutes(app: FastifyInstance) {
  // ── Stars ──────────────────────────────────────────────────────────────────

  // PUT /repos/:handle/:name/star — idempotent star.
  app.put("/repos/:handle/:name/star", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    await prisma.star.upsert({
      where: { userId_repoId: { userId, repoId: repo.id } },
      create: { userId, repoId: repo.id },
      update: {},
    });
    const starCount = await prisma.star.count({ where: { repoId: repo.id } });
    return { starred: true, starCount };
  });

  // DELETE /repos/:handle/:name/star — idempotent unstar.
  app.delete("/repos/:handle/:name/star", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    await prisma.star.deleteMany({ where: { userId, repoId: repo.id } });
    const starCount = await prisma.star.count({ where: { repoId: repo.id } });
    return { starred: false, starCount };
  });

  // GET /users/:handle/starred — the repos a user starred, newest star first,
  // filtered to what the VIEWER may read (a private repo never leaks through
  // someone else's starred list).
  app.get("/users/:handle/starred", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle: handleParam } = request.params as { handle: string };
    const user = await prisma.user.findUnique({ where: { handle: handleParam.toLowerCase() } });
    if (!user) return reply.status(404).send({ error: "User not found" });

    const vid = viewerId(request as { user?: { sub: string } });
    const stars = await prisma.star.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        repo: {
          include: {
            ...repoAccessInclude,
            owner: { select: { handle: true } },
            topics: { orderBy: { topic: "asc" }, select: { topic: true } },
            _count: { select: { stars: true } },
          },
        },
      },
    });

    return {
      repos: stars
        .filter((s) => canRead(s.repo, vid))
        .map((s) => ({ ...repoResponse(s.repo), starredAt: s.createdAt.toISOString() })),
    };
  });

  // ── Watching ───────────────────────────────────────────────────────────────

  // GET /repos/:handle/:name/social — the viewer's star/watch state plus the
  // grouped star count, in one call for the repo header.
  app.get("/repos/:handle/:name/social", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const vid = viewerId(request as { user?: { sub: string } });

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, vid)) return reply.status(404).send({ error: "Not found" });

    const starCount = await prisma.star.count({ where: { repoId: repo.id } });
    if (!vid) return { starCount, viewerStarred: false, watchLevel: "participating" as const };

    const [star, watch] = await Promise.all([
      prisma.star.findUnique({ where: { userId_repoId: { userId: vid, repoId: repo.id } } }),
      prisma.watch.findUnique({ where: { userId_repoId: { userId: vid, repoId: repo.id } } }),
    ]);
    return {
      starCount,
      viewerStarred: !!star,
      watchLevel: watch ? fromDbWatchLevel(watch.level) : defaultWatchLevel(repo, vid),
    };
  });

  // PUT /repos/:handle/:name/watch — set the three-level subscription. Any
  // reader may watch (or IGNORE to mute); repo membership is not required.
  app.put("/repos/:handle/:name/watch", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = setWatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const level = toDbWatchLevel(parsed.data.level);
    await prisma.watch.upsert({
      where: { userId_repoId: { userId, repoId: repo.id } },
      create: { userId, repoId: repo.id, level },
      update: { level },
    });
    return { watchLevel: parsed.data.level };
  });

  // DELETE /repos/:handle/:name/watch — drop the explicit choice, falling back
  // to the default (implicit ALL for owner/collaborators, PARTICIPATING otherwise).
  app.delete("/repos/:handle/:name/watch", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    await prisma.watch.deleteMany({ where: { userId, repoId: repo.id } });
    return { watchLevel: defaultWatchLevel(repo, userId) };
  });

  // ── Feed ───────────────────────────────────────────────────────────────────

  // GET /feed?page=N&per_page=N — recent activity across the caller's watched
  // (non-IGNORE) + starred repos, newest first. Offset pagination over an
  // in-memory merge of the (bounded) per-source reads: each source is fetched
  // to the current window only, so a deep page costs proportionally, and v0
  // needs no cross-table event index. Private-repo activity is filtered by a
  // canRead pass over the candidate repos BEFORE any event query — losing
  // access to a repo you starred silently drops it from the feed.
  app.get("/feed", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const { page: pageQ, per_page: perPageQ } = request.query as { page?: string; per_page?: string };
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(perPageQ ?? "25", 10) || 25));

    const [stars, watches] = await Promise.all([
      prisma.star.findMany({ where: { userId }, select: { repoId: true } }),
      prisma.watch.findMany({ where: { userId }, select: { repoId: true, level: true } }),
    ]);
    const candidateIds = new Set<string>([
      ...stars.map((s) => s.repoId),
      ...watches.filter((w) => w.level !== "IGNORE").map((w) => w.repoId),
    ]);
    if (candidateIds.size === 0) return { items: [], page, perPage, hasMore: false };

    const repos = await prisma.repo.findMany({
      where: { id: { in: [...candidateIds] } },
      include: { ...repoAccessInclude, owner: { select: { handle: true } } },
    });
    const readable = repos.filter((r) => canRead(r, userId));
    if (readable.length === 0) return { items: [], page, perPage, hasMore: false };

    const repoRef = new Map(
      readable.map((r) => [r.id, { ownerHandle: r.org?.handle ?? r.owner.handle, name: r.name }]),
    );
    const repoIds = [...repoRef.keys()];

    // One row beyond the window is enough to answer hasMore.
    const window = page * perPage + 1;
    const authorSel = { select: { handle: true } } as const;
    const [issues, pulls, releases, events] = await Promise.all([
      prisma.issue.findMany({
        where: { repoId: { in: repoIds } },
        orderBy: { createdAt: "desc" },
        take: window,
        include: { author: authorSel },
      }),
      prisma.pullRequest.findMany({
        where: { repoId: { in: repoIds } },
        orderBy: { createdAt: "desc" },
        take: window,
        include: { author: authorSel },
      }),
      prisma.release.findMany({
        where: { repoId: { in: repoIds }, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: window,
        include: { author: authorSel },
      }),
      prisma.timelineEvent.findMany({
        where: { repoId: { in: repoIds }, kind: { in: [...FEED_TIMELINE_KINDS] } },
        orderBy: { createdAt: "desc" },
        take: window,
      }),
    ]);

    type Sortable = { item: FeedItem; at: Date };
    const entries: Sortable[] = [];
    for (const i of issues) {
      const repo = repoRef.get(i.repoId);
      if (!repo) continue;
      entries.push({
        at: i.createdAt,
        item: { type: "issue_opened", id: `issue-${i.id}`, repo, actor: i.author.handle, number: i.number, title: i.title, createdAt: i.createdAt.toISOString() },
      });
    }
    for (const p of pulls) {
      const repo = repoRef.get(p.repoId);
      if (!repo) continue;
      entries.push({
        at: p.createdAt,
        item: { type: "pr_opened", id: `pr-${p.id}`, repo, actor: p.author.handle, number: p.number, title: p.title, createdAt: p.createdAt.toISOString() },
      });
    }
    for (const rel of releases) {
      const repo = repoRef.get(rel.repoId);
      if (!repo) continue;
      entries.push({
        at: rel.createdAt,
        item: { type: "release", id: `release-${rel.id}`, repo, actor: rel.author.handle, tagName: rel.tagName, releaseName: rel.name, createdAt: rel.createdAt.toISOString() },
      });
    }
    for (const e of events) {
      const repo = repoRef.get(e.repoId);
      if (!repo) continue;
      // Actor handle is denormalized into `data` by recordEvent — no join needed.
      let actorHandle = "ghost";
      try {
        const parsed = JSON.parse(e.data) as { actorHandle?: unknown };
        if (typeof parsed.actorHandle === "string") actorHandle = parsed.actorHandle;
      } catch { /* keep ghost on malformed json */ }
      entries.push({
        at: e.createdAt,
        item: {
          type: "timeline",
          id: `event-${e.id}`,
          repo,
          actor: actorHandle,
          kind: e.kind,
          subjectType: e.subjectType === "PULL_REQUEST" ? "pull_request" : "issue",
          number: e.subjectNumber,
          createdAt: e.createdAt.toISOString(),
        },
      });
    }

    entries.sort((a, b) => b.at.getTime() - a.at.getTime() || a.item.id.localeCompare(b.item.id));
    const start = (page - 1) * perPage;
    const pageItems = entries.slice(start, start + perPage).map((e) => e.item);
    const hasMore = entries.length > page * perPage;

    // Resolve subject titles for the timeline slice (2 bounded lookups max) so
    // the feed can say WHAT was closed/merged, not just its number.
    const wantTitles = pageItems.filter((i) => i.type === "timeline" && i.number != null);
    if (wantTitles.length > 0) {
      const key = (repoId: string, type: string, number: number) => `${repoId}:${type}:${number}`;
      const titleByKey = new Map<string, string>();
      const idByRef = new Map(readable.map((r) => [`${repoRef.get(r.id)!.ownerHandle}/${r.name}`, r.id]));
      const refs = wantTitles.map((i) => ({
        repoId: idByRef.get(`${i.repo.ownerHandle}/${i.repo.name}`)!,
        type: i.subjectType!,
        number: i.number!,
      }));
      const issueRefs = refs.filter((r) => r.type === "issue");
      const pullRefs = refs.filter((r) => r.type === "pull_request");
      const [issueRows, pullRows] = await Promise.all([
        issueRefs.length > 0
          ? prisma.issue.findMany({
              where: { OR: issueRefs.map((r) => ({ repoId: r.repoId, number: r.number })) },
              select: { repoId: true, number: true, title: true },
            })
          : Promise.resolve([]),
        pullRefs.length > 0
          ? prisma.pullRequest.findMany({
              where: { OR: pullRefs.map((r) => ({ repoId: r.repoId, number: r.number })) },
              select: { repoId: true, number: true, title: true },
            })
          : Promise.resolve([]),
      ]);
      for (const row of issueRows) titleByKey.set(key(row.repoId, "issue", row.number), row.title);
      for (const row of pullRows) titleByKey.set(key(row.repoId, "pull_request", row.number), row.title);
      for (const i of wantTitles) {
        const repoId = idByRef.get(`${i.repo.ownerHandle}/${i.repo.name}`);
        if (!repoId) continue;
        i.title = titleByKey.get(key(repoId, i.subjectType!, i.number!));
      }
    }

    return { items: pageItems, page, perPage, hasMore };
  });
}
