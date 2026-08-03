import { describe, it, expect } from "vitest";
import { REACTION_EMOJIS, REACTION_GLYPHS, reactionPills, toggleReaction } from "../lib/reactions";
import type { ReactionState } from "../types";

describe("reactionPills", () => {
  it("returns only emoji with positive counts, in canonical order", () => {
    const state: ReactionState = {
      // Deliberately out of canonical order (and with a zero entry).
      reactions: { eyes: 2, "+1": 3, laugh: 0, heart: 1 },
      viewerReacted: ["heart"],
    };
    const pills = reactionPills(state);
    expect(pills.map((p) => p.emoji)).toEqual(["+1", "heart", "eyes"]);
    expect(pills.map((p) => p.viewerReacted)).toEqual([false, true, false]);
    expect(pills[0]!.glyph).toBe(REACTION_GLYPHS["+1"]);
  });

  it("is empty for a subject nobody reacted to", () => {
    expect(reactionPills({ reactions: {}, viewerReacted: [] })).toEqual([]);
  });

  it("covers the full fixed set of 8", () => {
    const reactions = Object.fromEntries(REACTION_EMOJIS.map((e) => [e, 1]));
    const pills = reactionPills({ reactions, viewerReacted: [] });
    expect(pills).toHaveLength(8);
    expect(pills.map((p) => p.emoji)).toEqual([...REACTION_EMOJIS]);
  });
});

describe("toggleReaction", () => {
  it("adds: increments the count and records the viewer", () => {
    const next = toggleReaction({ reactions: { "+1": 2 }, viewerReacted: [] }, "+1");
    expect(next).toEqual({ reactions: { "+1": 3 }, viewerReacted: ["+1"] });
  });

  it("adds a first reaction from zero", () => {
    const next = toggleReaction({ reactions: {}, viewerReacted: [] }, "rocket");
    expect(next).toEqual({ reactions: { rocket: 1 }, viewerReacted: ["rocket"] });
  });

  it("removes: decrements and drops the viewer, keeping others' counts", () => {
    const next = toggleReaction({ reactions: { heart: 2 }, viewerReacted: ["heart"] }, "heart");
    expect(next).toEqual({ reactions: { heart: 1 }, viewerReacted: [] });
  });

  it("removing the last reaction drops the emoji key entirely", () => {
    const next = toggleReaction({ reactions: { eyes: 1 }, viewerReacted: ["eyes"] }, "eyes");
    expect(next).toEqual({ reactions: {}, viewerReacted: [] });
  });

  it("round-trips back to the starting state", () => {
    const start: ReactionState = { reactions: { "-1": 1 }, viewerReacted: [] };
    const there = toggleReaction(start, "-1");
    expect(toggleReaction(there, "-1")).toEqual(start);
  });

  it("never mutates its input", () => {
    const start: ReactionState = { reactions: { laugh: 1 }, viewerReacted: ["laugh"] };
    toggleReaction(start, "laugh");
    toggleReaction(start, "hooray");
    expect(start).toEqual({ reactions: { laugh: 1 }, viewerReacted: ["laugh"] });
  });

  it("only touches the toggled emoji", () => {
    const next = toggleReaction({ reactions: { "+1": 4, confused: 1 }, viewerReacted: ["confused"] }, "+1");
    expect(next.reactions).toEqual({ "+1": 5, confused: 1 });
    expect(next.viewerReacted).toEqual(["confused", "+1"]);
  });
});
