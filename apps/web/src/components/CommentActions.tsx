import { useState } from "react";
import type { RepoRef } from "../lib/autolink";
import { Button, DropdownItem, DropdownMenu, DropdownSeparator, useToast } from "../ui";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownRenderer } from "./MarkdownRenderer";

/** `> `-quote a comment for a reply (#253), GitHub's "Quote reply". */
export function quoteReply(body: string): string {
  return body.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
}

/**
 * The "…" menu on a comment (#253): copy a link to it, quote it in a reply,
 * and, for whoever may, edit or delete it.
 */
export function CommentMenu({ anchor, onQuote, onEdit, onDelete }: {
  /** The comment's element id, for "Copy link". */
  anchor: string;
  onQuote?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { toast } = useToast();
  function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}#${anchor}`;
    navigator.clipboard?.writeText(url).then(() => toast("Link copied", { tone: "success" })).catch(() => {});
  }
  return (
    <DropdownMenu
      align="end"
      width={180}
      trigger={
        <button type="button" aria-label="Comment actions" className="ml-auto rounded-md px-1.5 text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM1.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm13 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
          </svg>
        </button>
      }
    >
      <DropdownItem onSelect={copyLink}>Copy link</DropdownItem>
      {onQuote && <DropdownItem onSelect={onQuote}>Quote reply</DropdownItem>}
      {(onEdit || onDelete) && <DropdownSeparator />}
      {onEdit && <DropdownItem onSelect={onEdit}>Edit</DropdownItem>}
      {onDelete && <DropdownItem danger onSelect={onDelete}>Delete</DropdownItem>}
    </DropdownMenu>
  );
}

/**
 * A comment's body, or its editor while editing (#253): Cancel or Escape
 * leaves the text as it was, "Update comment" saves.
 */
export function EditableBody({ token, repo, body, editing, onCancel, onSave, empty, saveLabel = "Update comment" }: {
  token: string;
  repo: RepoRef;
  body: string | null;
  editing: boolean;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
  /** Shown for an empty body (an issue or pull request without a description). */
  empty?: string;
  saveLabel?: string;
}) {
  const [draft, setDraft] = useState(body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return body ? <MarkdownRenderer content={body} repo={repo} /> : <p className="text-fh-sm italic text-fh-fg-muted">{empty ?? ""}</p>;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <MarkdownEditor value={draft} onValueChange={setDraft} onSubmit={() => void save()} onCancel={onCancel} token={token} repo={repo} autoFocus rows={5} />
      {error && <p className="mt-2 text-fh-sm text-fh-danger-fg">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="default" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>{saveLabel}</Button>
      </div>
    </div>
  );
}
