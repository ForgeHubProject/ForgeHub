import { useEffect, useState } from "react";
import { DropdownMenu, cx } from "../ui";
import { addReaction, removeReaction, type ReactionSubjectType } from "../api";
import { REACTION_EMOJIS, REACTION_GLYPHS, reactionPills, toggleReaction } from "../lib/reactions";
import type { ReactionEmoji, ReactionState } from "../types";

/** GitHub-style "add reaction" smiley-plus glyph. */
function SmileyPlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0a8 8 0 1 1-.727 15.966A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5.32 9.24a.75.75 0 0 1 1.05.14c.4.52.927.87 1.63.87s1.23-.35 1.63-.87a.75.75 0 1 1 1.19.91c-.64.84-1.585 1.46-2.82 1.46s-2.18-.62-2.82-1.46a.75.75 0 0 1 .14-1.05ZM5.5 5.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
    </svg>
  );
}

/**
 * Emoji reaction pills + picker for one subject (issue #90). Shows the grouped
 * counts, highlights the viewer's own reactions, and toggles optimistically:
 * the pill updates instantly, then reconciles to the server's rollup (or rolls
 * back on failure). Logged-out viewers see the pills read-only, no picker.
 */
export function ReactionBar({
  token,
  handle,
  repoName,
  subjectType,
  subjectId,
  reactions,
  viewerReacted,
  className,
}: {
  token: string | null;
  handle: string;
  repoName: string;
  subjectType: ReactionSubjectType;
  subjectId: string;
  reactions?: Record<string, number>;
  viewerReacted?: string[];
  className?: string;
}) {
  const [state, setState] = useState<ReactionState>({
    reactions: reactions ?? {},
    viewerReacted: viewerReacted ?? [],
  });
  const [busy, setBusy] = useState(false);

  // Re-seed when the subject (or a refetched payload) changes under us.
  useEffect(() => {
    setState({ reactions: reactions ?? {}, viewerReacted: viewerReacted ?? [] });
    // Serialized deps: the parent passes fresh object/array identities per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId, JSON.stringify(reactions ?? {}), JSON.stringify(viewerReacted ?? [])]);

  async function toggle(emoji: ReactionEmoji) {
    if (!token || busy) return;
    const prev = state;
    const removing = prev.viewerReacted.includes(emoji);
    setState(toggleReaction(prev, emoji));
    setBusy(true);
    try {
      const result = removing
        ? await removeReaction(token, handle, repoName, subjectType, subjectId, emoji)
        : await addReaction(token, handle, repoName, subjectType, subjectId, emoji);
      // Reconcile to the server's rollup — it's the truth if others reacted too.
      setState({ reactions: result.reactions, viewerReacted: result.viewerReacted });
    } catch {
      setState(prev); // roll back the optimistic flip
    } finally {
      setBusy(false);
    }
  }

  const pills = reactionPills(state);
  if (pills.length === 0 && !token) return null;

  return (
    <div className={cx("flex items-center gap-1.5 flex-wrap", className)}>
      {token && (
        <DropdownMenu
          align="start"
          trigger={
            <button
              type="button"
              aria-label="Add reaction"
              disabled={busy}
              className="inline-flex items-center justify-center w-7 h-6 rounded-full border border-fh-border text-fh-fg-muted hover:text-fh-fg hover:bg-fh-surface-muted disabled:opacity-50"
            >
              <SmileyPlusIcon size={14} />
            </button>
          }
        >
          <div className="flex items-center gap-0.5 px-1.5 py-0.5">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-label={`React with ${emoji}`}
                onClick={() => toggle(emoji)}
                className={cx(
                  "inline-flex items-center justify-center w-7 h-7 rounded-md text-fh-base bg-transparent border-none cursor-pointer",
                  "outline-none focus:bg-fh-accent-muted hover:bg-fh-accent-muted",
                  state.viewerReacted.includes(emoji) && "bg-fh-accent-muted",
                )}
              >
                {REACTION_GLYPHS[emoji]}
              </button>
            ))}
          </div>
        </DropdownMenu>
      )}

      {pills.map((pill) => (
        <button
          key={pill.emoji}
          type="button"
          disabled={!token || busy}
          aria-pressed={pill.viewerReacted}
          aria-label={`${pill.count} reacted with ${pill.emoji}`}
          onClick={() => toggle(pill.emoji)}
          className={cx(
            "inline-flex items-center gap-1 px-2 h-6 rounded-full border text-fh-xs cursor-pointer",
            pill.viewerReacted
              ? "border-fh-accent-fg/40 bg-fh-accent-muted text-fh-accent-fg font-semibold"
              : "border-fh-border bg-fh-surface text-fh-fg-muted hover:bg-fh-surface-muted",
            !token && "cursor-default",
          )}
        >
          <span aria-hidden="true">{pill.glyph}</span>
          {pill.count}
        </button>
      ))}
    </div>
  );
}
