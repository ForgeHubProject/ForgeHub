import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude, resolveRepo, type RepoAccessInput } from "../repo-access.js";
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

/**
 * Feed cursor: the last entry already delivered, as `<createdAt ISO>|<item id>`.
 * The item id breaks ties at an identical timestamp, matching the merge sort
 * (createdAt DESC, then id ASC). Cursors — not offsets — because the feed is a
 * live stream: activity arriving between two page fetches shifts every offset,
 * which duplicates or skips entries. Malformed input is treated as "no cursor".
 */
type FeedCursor = { at: Date; id: string };

function parseFeedCursor(raw: string | undefined): FeedCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const at = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || id === "") return null;
  return { at, id };
}

function encodeFeedCursor(item: FeedItem): string {
  return `${item.createdAt}|${item.id}`;
}

/**
 * Binary id ordering — deliberately not `localeCompare`, because the same
 * comparison is handed to the database as an `id: { gt: … }` bound and SQLite
 * compares TEXT bit by bit. The merge sort and the cursor `where` must agree
 * exactly or a page boundary drops (or repeats) an entry.
 */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The per-source `where` fragment for "strictly after the cursor" in the merge
 * order (createdAt DESC, item id ASC). Strictness is what makes the bounded
 * per-source window safe: a `lte` filter re-fetches the cursor row itself, so
 * the source that produced the cursor spends one of its `perPage + 1` slots on
 * a row that is then discarded and can never report that more remains.
 *
 * `prefix` is the source's item-id prefix, so the id tiebreak is evaluated in
 * the SAME namespace the merge sort uses. When the cursor came from this source
 * the tiebreak reduces to a plain id comparison; when it came from another
 * source the prefixes differ before the ids do, so the prefixes alone decide
 * the whole same-timestamp group.
 */
function feedCursorWhere(cursor: FeedCursor | null, prefix: string) {
  if (!cursor) return {};
  const before = { createdAt: { lt: cursor.at } };
  const tag = `${prefix}-`;
  if (cursor.id.startsWith(tag)) {
    return { OR: [before, { createdAt: cursor.at, id: { gt: cursor.id.slice(tag.length) } }] };
  }
  return compareId(tag, cursor.id) > 0 ? { OR: [before, { createdAt: cursor.at }] } : before;
}

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

  // GET /users/:handle/starred?page=N&per_page=N — the repos a user starred,
  // newest star first, filtered to what the VIEWER may read (a private repo
  // never leaks through someone else's starred list). The read is BOUNDED to the
  // requested window like the neighbouring list endpoints — the per-repo access
  // include (org memberships + team member sets) is far too heavy to pull for
  // every star a user ever made. Viewer filtering happens after the window, so a
  // page can come back shorter than `perPage`; `hasMore` still paginates
  // correctly because it is answered from the raw star rows.
  app.get("/users/:handle/starred", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle: handleParam } = request.params as { handle: string };
    const { page: pageQ, per_page: perPageQ } = request.query as { page?: string; per_page?: string };
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(perPageQ ?? "25", 10) || 25));

    const user = await prisma.user.findUnique({ where: { handle: handleParam.toLowerCase() } });
    if (!user) return reply.status(404).send({ error: "User not found" });

    const vid = viewerId(request as { user?: { sub: string } });
    const stars = await prisma.star.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage + 1, // one beyond the window answers hasMore
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

    const hasMore = stars.length > perPage;
    return {
      repos: stars
        .slice(0, perPage)
        .filter((s) => canRead(s.repo, vid))
        .map((s) => ({ ...repoResponse(s.repo), starredAt: s.createdAt.toISOString() })),
      page,
      perPage,
      hasMore,
    };
  });

  // ── Watching ───────────────────────────────────────────────────────────────

  /**
   * How many users the repo-wide fan-out actually reaches — the same set
   * `notifySubscribers` computes, derived the same way: every explicit ALL row,
   * plus every owner/collaborator whose implicit ALL was never materialized,
   * then intersected with LIVE read access. That last step is not optional: a
   * Watch row is a subscription, never a grant, so a stale ALL row on a private
   * repo would otherwise inflate the count with someone the fan-out will never
   * reach. No denormalized counter (matching `starCount`).
   *
   * The read is bounded, and that matters: this sits on the repo-page hot path
   * (`GET /repos/:h/:n/social`, fetched on every repo view). On a PUBLIC repo —
   * precisely where the watcher set is largest — `canRead` is unconditionally
   * true, so the access intersection cannot subtract anyone and there is nothing
   * to materialize: an aggregate counts the explicit ALL rows and a second read
   * bounded by the (small) owner+collaborator set finds which members still need
   * their implicit ALL added.
   *
   * A PRIVATE repo does read rows, and its row set is bounded by NOTHING on its
   * own: a Watch row is a subscription, never a grant, so rows survive every
   * access path with no cleanup hook — an org membership change, a team-grant
   * removal, or a visibility flip (`PATCH /repos/:name` writes `visibility` and
   * prunes no rows, so a public repo's entire subscriber set stays behind when
   * it goes private). The bound is imposed here instead: the read is restricted
   * to the GRANTEE set — owner + collaborators + org OWNERs + members of teams
   * granted this repo, all already loaded by `repoAccessInclude` — because on a
   * private repo `canRead` is true for exactly those users, and the intersection
   * below discards every other row anyway. Same reasoning as the PUBLIC branch,
   * and it changes no result.
   */
  async function watcherCount(repo: RepoAccessInput & { id: string }): Promise<number> {
    const memberIds = [...new Set([repo.ownerId, ...repo.collaborators.map((c) => c.userId)])];

    if (repo.visibility === "PUBLIC") {
      const [explicitAll, memberRows] = await Promise.all([
        prisma.watch.count({ where: { repoId: repo.id, level: "ALL" } }),
        prisma.watch.findMany({
          where: { repoId: repo.id, userId: { in: memberIds } },
          select: { userId: true },
        }),
      ]);
      const hasRow = new Set(memberRows.map((r) => r.userId));
      // Disjoint by construction: a member with a row is never implicit, and an
      // ALL row is counted once by the aggregate.
      return explicitAll + memberIds.filter((uid) => !hasRow.has(uid)).length;
    }

    // Every user `canRead` admits on a PRIVATE repo, and no other.
    const granteeIds = [
      ...new Set([
        ...memberIds,
        ...(repo.org?.memberships ?? []).filter((m) => m.role === "OWNER").map((m) => m.userId),
        ...(repo.teamAccess ?? []).flatMap((a) => a.team.memberships.map((m) => m.userId)),
      ]),
    ];
    const watches = await prisma.watch.findMany({
      where: { repoId: repo.id, userId: { in: granteeIds } },
      select: { userId: true, level: true },
    });
    const levelByUser = new Map(watches.map((w) => [w.userId, w.level]));

    const watchers = new Set<string>();
    for (const w of watches) {
      if (w.level === "ALL") watchers.add(w.userId);
    }
    for (const uid of memberIds) {
      if (!levelByUser.has(uid)) watchers.add(uid);
    }
    return [...watchers].filter((uid) => canRead(repo, uid)).length;
  }

  // GET /repos/:handle/:name/social — the viewer's star/watch state plus the
  // grouped star and watcher counts, in one call for the repo header.
  app.get("/repos/:handle/:name/social", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const vid = viewerId(request as { user?: { sub: string } });

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, vid)) return reply.status(404).send({ error: "Not found" });

    const [starCount, watchers] = await Promise.all([
      prisma.star.count({ where: { repoId: repo.id } }),
      watcherCount(repo),
    ]);
    if (!vid) return { starCount, watcherCount: watchers, viewerStarred: false, watchLevel: "participating" as const };

    const [star, watch] = await Promise.all([
      prisma.star.findUnique({ where: { userId_repoId: { userId: vid, repoId: repo.id } } }),
      prisma.watch.findUnique({ where: { userId_repoId: { userId: vid, repoId: repo.id } } }),
    ]);
    return {
      starCount,
      watcherCount: watchers,
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
    return { watchLevel: parsed.data.level, watcherCount: await watcherCount(repo) };
  });

  // DELETE /repos/:handle/:name/watch — drop the explicit choice, falling back
  // to the default (implicit ALL for owner/collaborators, PARTICIPATING otherwise).
  app.delete("/repos/:handle/:name/watch", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    await prisma.watch.deleteMany({ where: { userId, repoId: repo.id } });
    return { watchLevel: defaultWatchLevel(repo, userId), watcherCount: await watcherCount(repo) };
  });

  // ── Feed ───────────────────────────────────────────────────────────────────

  // GET /feed?cursor=<createdAt|id>&per_page=N — recent activity across the
  // caller's watched (non-IGNORE) + starred repos, newest first. CURSOR
  // pagination over an in-memory merge of the (bounded) per-source reads: every
  // source is capped at `perPage + 1` rows STRICTLY after the cursor, so a deep
  // page costs the same as the first one and no page re-fetches what earlier
  // pages already read. Private-repo activity is filtered by a canRead pass over
  // the candidate repos BEFORE any event query — losing access to a repo you
  // starred silently drops it from the feed.
  app.get("/feed", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const { cursor: cursorQ, per_page: perPageQ } = request.query as { cursor?: string; per_page?: string };
    const perPage = Math.min(50, Math.max(1, parseInt(perPageQ ?? "25", 10) || 25));
    const cursor = parseFeedCursor(cursorQ);
    const empty = { items: [] as FeedItem[], perPage, nextCursor: null, hasMore: false };

    const [stars, watches] = await Promise.all([
      prisma.star.findMany({ where: { userId }, select: { repoId: true } }),
      prisma.watch.findMany({ where: { userId }, select: { repoId: true, level: true } }),
    ]);
    const candidateIds = new Set<string>([
      ...stars.map((s) => s.repoId),
      ...watches.filter((w) => w.level !== "IGNORE").map((w) => w.repoId),
    ]);
    if (candidateIds.size === 0) return empty;

    const repos = await prisma.repo.findMany({
      where: { id: { in: [...candidateIds] } },
      include: { ...repoAccessInclude, owner: { select: { handle: true } } },
    });
    const readable = repos.filter((r) => canRead(r, userId));
    if (readable.length === 0) return empty;

    const repoRef = new Map(
      readable.map((r) => [r.id, { ownerHandle: r.org?.handle ?? r.owner.handle, name: r.name }]),
    );
    const repoIds = [...repoRef.keys()];

    // One row beyond the page is enough to answer hasMore, per source — but
    // only because `feedCursorWhere` is STRICTLY after the cursor, so all
    // `perPage + 1` rows a source returns are rows this page may still serve.
    //
    // Every source orders by the FULL merge key, `(createdAt DESC, id ASC)` —
    // not `createdAt` alone. A bare `createdAt DESC` leaves rows sharing one
    // timestamp in whatever order the storage engine hands back (SQLite returns
    // them in physical order), so a `take: perPage + 1` window would slice an
    // ARBITRARY subset out of a tie group while the cursor still advances with
    // `id: { gt: … }` — permanently stranding every tied row whose id sorts
    // at-or-below the one served last, including rows the window never
    // returned. Asking for the id tiebreak makes the window genuinely the top
    // `perPage + 1` rows in merge order, and makes the `id` bound
    // index-alignable rather than a filter over an arbitrary slice.
    const feedOrder = [{ createdAt: "desc" as const }, { id: "asc" as const }];
    const window = perPage + 1;
    const authorSel = { select: { handle: true } } as const;
    const [issues, pulls, releases, events] = await Promise.all([
      prisma.issue.findMany({
        where: { repoId: { in: repoIds }, ...feedCursorWhere(cursor, "issue") },
        orderBy: feedOrder,
        take: window,
        include: { author: authorSel },
      }),
      prisma.pullRequest.findMany({
        where: { repoId: { in: repoIds }, ...feedCursorWhere(cursor, "pr") },
        orderBy: feedOrder,
        take: window,
        include: { author: authorSel },
      }),
      prisma.release.findMany({
        where: { repoId: { in: repoIds }, isDraft: false, ...feedCursorWhere(cursor, "release") },
        orderBy: feedOrder,
        take: window,
        include: { author: authorSel },
      }),
      prisma.timelineEvent.findMany({
        where: { repoId: { in: repoIds }, kind: { in: [...FEED_TIMELINE_KINDS] }, ...feedCursorWhere(cursor, "event") },
        orderBy: feedOrder,
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

    entries.sort((a, b) => b.at.getTime() - a.at.getTime() || compareId(a.item.id, b.item.id));
    // The same "strictly after the cursor" predicate the source queries applied,
    // re-stated over the merged stream. It is a no-op against a database that
    // orders text the way `compareId` does; it is here so that a source whose
    // rows arrive some other way can never re-serve an entry.
    const fresh = cursor
      ? entries.filter(
          (e) =>
            e.at.getTime() < cursor.at.getTime() ||
            (e.at.getTime() === cursor.at.getTime() && compareId(e.item.id, cursor.id) > 0),
        )
      : entries;
    const pageItems = fresh.slice(0, perPage).map((e) => e.item);
    const hasMore = fresh.length > perPage;
    const last = pageItems.at(-1);
    const nextCursor = hasMore && last ? encodeFeedCursor(last) : null;

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

    return { items: pageItems, perPage, nextCursor, hasMore };
  });
}
