import { prisma } from "./prisma.js";
import { canRead, repoAccessInclude } from "./repo-access.js";

/** Wire-format watch level; DB stores the uppercase enum. */
export type ApiWatchLevel = "all" | "participating" | "ignore";

export function toDbWatchLevel(level: ApiWatchLevel): "ALL" | "PARTICIPATING" | "IGNORE" {
  return level.toUpperCase() as "ALL" | "PARTICIPATING" | "IGNORE";
}

export function fromDbWatchLevel(level: string): ApiWatchLevel {
  return level.toLowerCase() as ApiWatchLevel;
}

/**
 * Materialize the implicit ALL watch an owner/collaborator gets (issue #88).
 * Upsert with an empty update so an explicit choice the user already made
 * (PARTICIPATING / IGNORE) is never overwritten by re-adding them. Best-effort
 * by design — a failure here must never fail repo creation or a collaborator
 * add, mirroring how recordEvent / webhook emits are treated.
 */
export async function ensureImplicitWatch(repoId: string, userId: string): Promise<void> {
  try {
    await prisma.watch.upsert({
      where: { userId_repoId: { userId, repoId } },
      create: { userId, repoId, level: "ALL" },
      update: {},
    });
  } catch {
    // Best-effort side effect; the caller's write already succeeded.
  }
}

/**
 * Drop a user's Watch row for a repo they can NO LONGER read (issue #88). Call
 * this right after revoking a grant: `ensureImplicitWatch` materializes an ALL
 * row for every collaborator, and that row would otherwise keep a removed
 * collaborator subscribed to a private repo's activity forever.
 *
 * The gate is `canRead`, not "was a collaborator": someone removed from a PUBLIC
 * repo can still read it, so their subscription is theirs to keep, and someone
 * who holds access by another route (org owner, team grant) is untouched. This
 * is the cleanup half of the fix — `notifySubscribers`/`notifyUser` re-check
 * read access at delivery time, which covers revocation paths that never call
 * here. Best-effort: the caller's revocation already succeeded.
 */
export async function pruneWatchOnAccessLoss(repoId: string, userId: string): Promise<void> {
  try {
    const repo = await prisma.repo.findUnique({ where: { id: repoId }, include: repoAccessInclude });
    if (!repo || canRead(repo, userId)) return;
    await prisma.watch.deleteMany({ where: { repoId, userId } });
  } catch {
    // Best-effort side effect; delivery-time canRead still blocks the leak.
  }
}

/** BackfillMarker key for the implicit-watch backfill below. */
const IMPLICIT_WATCH_BACKFILL = "implicit-watches-v1";

/** How many repos one backfill batch holds in memory at a time. */
const BACKFILL_BATCH = 200;

/**
 * TRULY one-time backfill: every repo owner + direct collaborator that predates
 * the Watch table gets their implicit ALL row. Run at server startup — NOT
 * inside buildServer, so tests that build the app against a mocked prisma never
 * hit it. Existing rows (any level) are left untouched.
 *
 * Two things keep boot cheap. A `BackfillMarker` row records completion, so
 * every restart after the first is a single indexed lookup instead of a full
 * repo scan — new repos don't need the backfill anyway, they get their rows
 * from `ensureImplicitWatch` on create / fork / collaborator add. And the scan
 * itself is cursor-batched, so peak memory is one batch rather than every repo
 * plus every collaborator on the instance.
 *
 * The marker is written only after a clean pass; a crash mid-backfill just means
 * the next boot redoes it, which the per-row upsert makes harmless.
 */
export async function backfillImplicitWatches(): Promise<void> {
  const done = await prisma.backfillMarker.findUnique({ where: { name: IMPLICIT_WATCH_BACKFILL } });
  if (done) return;

  let cursor: string | undefined;
  for (;;) {
    const repos = await prisma.repo.findMany({
      select: { id: true, ownerId: true, collaborators: { select: { userId: true } } },
      orderBy: { id: "asc" },
      take: BACKFILL_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (repos.length === 0) break;

    for (const repo of repos) {
      const members = new Set<string>([repo.ownerId, ...repo.collaborators.map((c) => c.userId)]);
      for (const userId of members) {
        await ensureImplicitWatch(repo.id, userId);
      }
    }
    if (repos.length < BACKFILL_BATCH) break;
    cursor = repos[repos.length - 1]!.id;
  }

  await prisma.backfillMarker.create({ data: { name: IMPLICIT_WATCH_BACKFILL } });
}
