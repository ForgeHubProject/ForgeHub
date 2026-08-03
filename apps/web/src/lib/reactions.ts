import type { ReactionEmoji, ReactionState } from "../types";

/**
 * Emoji reaction display logic (issue #90): the fixed set of 8 shortcodes in
 * canonical order, their rendered glyphs, and the pure state math the
 * ReactionBar uses for its optimistic toggle — kept UI-free so it's testable.
 */

/** Canonical order — pills and the picker render in this order, always. */
export const REACTION_EMOJIS: ReactionEmoji[] = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];

/** Shortcode → rendered glyph. */
export const REACTION_GLYPHS: Record<ReactionEmoji, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  confused: "😕",
  heart: "❤️",
  hooray: "🎉",
  rocket: "🚀",
  eyes: "👀",
};

/** One rendered count pill. */
export type ReactionPill = {
  emoji: ReactionEmoji;
  glyph: string;
  count: number;
  viewerReacted: boolean;
};

/**
 * The pills to render for a reaction state: only emoji with a positive count,
 * in canonical order regardless of the order the server (or an optimistic
 * update) produced the record in.
 */
export function reactionPills(state: ReactionState): ReactionPill[] {
  const viewer = new Set(state.viewerReacted);
  return REACTION_EMOJIS
    .filter((emoji) => (state.reactions[emoji] ?? 0) > 0)
    .map((emoji) => ({
      emoji,
      glyph: REACTION_GLYPHS[emoji],
      count: state.reactions[emoji] ?? 0,
      viewerReacted: viewer.has(emoji),
    }));
}

/**
 * Optimistic toggle: the state the server WILL converge to when the viewer's
 * add/remove lands. Removing decrements (dropping the emoji at zero); adding
 * increments. Idempotent on repeated application in the same direction, so a
 * double-fired click can't drift the count. Never mutates the input.
 */
export function toggleReaction(state: ReactionState, emoji: ReactionEmoji): ReactionState {
  const has = state.viewerReacted.includes(emoji);
  const count = state.reactions[emoji] ?? 0;
  const reactions = { ...state.reactions };
  if (has) {
    if (count <= 1) delete reactions[emoji];
    else reactions[emoji] = count - 1;
    return { reactions, viewerReacted: state.viewerReacted.filter((e) => e !== emoji) };
  }
  reactions[emoji] = count + 1;
  return { reactions, viewerReacted: [...state.viewerReacted, emoji] };
}
