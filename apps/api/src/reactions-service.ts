import { prisma } from "./prisma.js";

/**
 * GitHub's fixed reaction set (issue #90), by shortcode, in canonical display
 * order. Validated server-side — no free-form emoji in v0.
 */
export const REACTION_EMOJIS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJIS as readonly string[]).includes(value);
}

/** DB-side subject discriminator (mirrors the ReactionSubjectType enum). */
export type ReactionSubjectType = "ISSUE" | "PULL_REQUEST" | "ISSUE_COMMENT" | "PR_COMMENT" | "PR_REVIEW_COMMENT";

/**
 * Grouped reaction state for one subject, as it rides on issue/PR/comment
 * payloads: per-emoji counts (only reacted-to emoji appear, in canonical
 * order) plus which of them the viewer has reacted with.
 */
export type ReactionRollup = {
  reactions: Record<string, number>;
  viewerReacted: string[];
};

export function emptyRollup(): ReactionRollup {
  return { reactions: {}, viewerReacted: [] };
}

/**
 * Batch-load reaction rollups for a set of subjects of one type — ONE query per
 * response regardless of list size (no N+1). A single findMany (rather than a
 * groupBy + a second viewer query) serves both the counts and the viewer state;
 * row volume is bounded at 8 emoji × participants per subject, which is fine at
 * this scale. Every requested id gets an entry, so callers can `.get(id)!`.
 */
export async function reactionRollups(
  subjectType: ReactionSubjectType,
  subjectIds: string[],
  viewerId?: string,
): Promise<Map<string, ReactionRollup>> {
  const map = new Map<string, ReactionRollup>(subjectIds.map((id) => [id, emptyRollup()]));
  if (subjectIds.length === 0) return map;

  const rows = await prisma.reaction.findMany({
    where: { subjectType, subjectId: { in: subjectIds } },
    select: { subjectId: true, emoji: true, userId: true },
  });

  // Tally per subject, then rebuild each record in canonical emoji order so
  // pill order is stable no matter the insertion order of the rows.
  const tallies = new Map<string, Map<string, number>>();
  const viewer = new Map<string, Set<string>>();
  for (const row of rows) {
    const tally = tallies.get(row.subjectId) ?? new Map<string, number>();
    tally.set(row.emoji, (tally.get(row.emoji) ?? 0) + 1);
    tallies.set(row.subjectId, tally);
    if (viewerId && row.userId === viewerId) {
      const set = viewer.get(row.subjectId) ?? new Set<string>();
      set.add(row.emoji);
      viewer.set(row.subjectId, set);
    }
  }
  for (const [subjectId, tally] of tallies) {
    const rollup = emptyRollup();
    for (const emoji of REACTION_EMOJIS) {
      const count = tally.get(emoji);
      if (count) rollup.reactions[emoji] = count;
      if (viewer.get(subjectId)?.has(emoji)) rollup.viewerReacted.push(emoji);
    }
    map.set(subjectId, rollup);
  }
  return map;
}

/** Rollup for a single subject (detail views + mutation responses). */
export async function reactionRollupFor(
  subjectType: ReactionSubjectType,
  subjectId: string,
  viewerId?: string,
): Promise<ReactionRollup> {
  const map = await reactionRollups(subjectType, [subjectId], viewerId);
  return map.get(subjectId) ?? emptyRollup();
}

/**
 * Remove all reactions for the given subjects. Called explicitly from the
 * subject DELETE handlers, since the polymorphic (subjectType, subjectId) pair
 * has no FK for the DB to cascade over. Empty id lists are skipped so callers
 * can pass cascade children (e.g. an issue's comment ids) unconditionally.
 */
export async function deleteSubjectReactions(
  targets: Array<{ subjectType: ReactionSubjectType; subjectIds: string[] }>,
): Promise<void> {
  const active = targets.filter((t) => t.subjectIds.length > 0);
  if (active.length === 0) return;
  await prisma.reaction.deleteMany({
    where: { OR: active.map((t) => ({ subjectType: t.subjectType, subjectId: { in: t.subjectIds } })) },
  });
}
