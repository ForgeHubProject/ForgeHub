import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSavedReplies } from "../api";
import type { SavedReply } from "../types";
import { DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator } from "../ui";

// One fetch per signed-in session, shared by every comment box on the page;
// the settings page drops it when the replies change.
const cache = new Map<string, Promise<SavedReply[]>>();

export function invalidateSavedReplies(): void {
  cache.clear();
}

function loadReplies(token: string): Promise<SavedReply[]> {
  let p = cache.get(token);
  if (!p) {
    p = listSavedReplies(token).then((d) => d.replies).catch(() => []);
    cache.set(token, p);
  }
  return p;
}

/** The comment box's saved replies button (#258): pick one to insert it at the caret. */
export function SavedRepliesMenu({ token, onInsert }: { token: string; onInsert: (body: string) => void }) {
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadReplies(token).then((r) => live && setReplies(r));
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <DropdownMenu
      align="end"
      width={300}
      searchPlaceholder="Filter saved replies"
      trigger={
        <button
          type="button"
          aria-label="Saved replies"
          title="Saved replies"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg"
        >
          <ReplyGlyph />
        </button>
      }
    >
      {(query) => {
        const q = query.trim().toLowerCase();
        const shown = (replies ?? []).filter((r) => !q || r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
        return (
          <>
            <DropdownLabel>Select a reply</DropdownLabel>
            {replies === null && <p className="px-3 py-2 text-fh-sm text-fh-fg-muted">Loading…</p>}
            {replies?.length === 0 && <p className="px-3 py-2 text-fh-sm text-fh-fg-muted">No saved replies yet.</p>}
            {shown.map((r) => (
              <DropdownItem key={r.id} onSelect={() => onInsert(r.body)}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">{r.title}</span>
                  <span className="truncate text-fh-xs text-fh-fg-muted">{r.body}</span>
                </span>
              </DropdownItem>
            ))}
            <DropdownSeparator />
            <Link to="/settings/replies" className="block px-3 py-2 text-fh-sm text-fh-accent-fg hover:underline">
              Create a new saved reply
            </Link>
          </>
        );
      }}
    </DropdownMenu>
  );
}

function ReplyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}
