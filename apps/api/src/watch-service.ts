import { prisma } from "./prisma.js";

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
 * One-time (idempotent) backfill: every repo owner + direct collaborator that
 * predates the Watch table gets their implicit ALL row. Run at server startup —
 * NOT inside buildServer, so tests that build the app against a mocked prisma
 * never hit it. Existing rows (any level) are left untouched.
 */
export async function backfillImplicitWatches(): Promise<void> {
  const repos = await prisma.repo.findMany({
    select: { id: true, ownerId: true, collaborators: { select: { userId: true } } },
  });
  for (const repo of repos) {
    const members = new Set<string>([repo.ownerId, ...repo.collaborators.map((c) => c.userId)]);
    for (const userId of members) {
      await ensureImplicitWatch(repo.id, userId);
    }
  }
}
