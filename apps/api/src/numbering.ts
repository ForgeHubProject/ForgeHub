import type { PrismaClient } from "@prisma/client";

/** The client or a transaction's: whichever the caller is writing with. */
type Db = Pick<PrismaClient, "issue" | "pullRequest" | "repo">;

/**
 * The number for a new issue or pull request in a repo. Issues and pull requests
 * share one sequence, as on GitHub (#259), so `#N` names exactly one of them.
 *
 * `Repo.lastNumber` is the counter. It is first raised to the highest number the
 * repo's issues and pull requests already hold: repos from before the counter
 * (which numbered each kind on its own), and rows written with their own numbers,
 * start the sequence above everything that exists. The raise only ever moves the
 * counter up, and the increment is a single atomic update, so two creations at
 * once still get two numbers.
 */
export async function nextNumber(db: Db, repoId: string): Promise<number> {
  const [issues, pulls] = await Promise.all([
    db.issue.aggregate({ where: { repoId }, _max: { number: true } }),
    db.pullRequest.aggregate({ where: { repoId }, _max: { number: true } }),
  ]);
  const floor = Math.max(issues._max.number ?? 0, pulls._max.number ?? 0);
  await db.repo.updateMany({ where: { id: repoId, lastNumber: { lt: floor } }, data: { lastNumber: floor } });
  const repo = await db.repo.update({
    where: { id: repoId },
    data: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });
  return repo.lastNumber;
}
