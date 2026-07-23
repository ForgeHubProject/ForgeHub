import { prisma } from "./prisma.js";

/**
 * Prisma `where` fragment for an issue/PR list filtered by milestone. Each member
 * is a valid partial of both `IssueWhereInput` and `PullRequestWhereInput`, so the
 * same resolver backs both list endpoints.
 */
export type MilestoneWhere =
  | Record<string, never>
  | { milestoneId: null }
  | { milestoneId: string }
  | { milestoneId: { not: null } }
  | { milestone: { title: string } };

/**
 * Resolve a `?milestone=` list-filter value into a `where` fragment (issue #83,
 * wave-A D2).
 *
 * Portability: the web UI serializes this filter by milestone NUMBER, while the
 * original API contract accepted a milestone TITLE — so the two disagreed and a
 * number-serialized filter silently matched nothing. We now accept EITHER form:
 * an all-digits value is resolved by the per-repo milestone `number` first, and
 * only if no such milestone exists do we fall back to a title match (so a
 * milestone literally titled "42" still resolves). The special sentinels are
 * preserved: `"none"` → issues with no milestone, `"*"` → any milestone, and an
 * absent param → no milestone filtering.
 */
export async function resolveMilestoneFilter(
  repoId: string,
  milestone: string | undefined,
): Promise<MilestoneWhere> {
  if (milestone === undefined) return {};
  if (milestone === "none") return { milestoneId: null };
  if (milestone === "*") return { milestoneId: { not: null } };
  if (/^\d+$/.test(milestone)) {
    const byNumber = await prisma.milestone.findFirst({
      where: { repoId, number: Number(milestone) },
      select: { id: true },
    });
    if (byNumber) return { milestoneId: byNumber.id };
  }
  return { milestone: { title: milestone } };
}
