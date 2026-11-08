import { useEffect, useState } from "react";
import { createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply } from "../api";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { invalidateSavedReplies } from "../components/SavedRepliesMenu";
import { SettingsLayout } from "../components/SettingsLayout";
import type { SavedReply, User } from "../types";
import { Button, ConfirmDialog, EmptyState, Field, PageHeading, Skeleton, TextInput, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Settings → Saved replies (#258): replies you reuse, inserted from any
 * comment box's toolbar.
 */
export function SettingsRepliesPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Saved replies · Settings · ForgeHub");
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [editing, setEditing] = useState<SavedReply | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    listSavedReplies(token).then((d) => setReplies(d.replies)).catch(() => setReplies([]));
  }, [token]);

  function saved(r: SavedReply, wasNew: boolean) {
    invalidateSavedReplies();
    setReplies((prev) => {
      const rest = (prev ?? []).filter((x) => x.id !== r.id);
      return [...rest, r].sort((a, b) => a.title.localeCompare(b.title));
    });
    setEditing(null);
    toast(wasNew ? "Saved reply added" : "Saved reply updated", { tone: "success" });
  }

  async function remove() {
    if (!deleting) return;
    try {
      await deleteSavedReply(token, deleting.id);
      invalidateSavedReplies();
      setReplies((prev) => (prev ?? []).filter((x) => x.id !== deleting.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't delete", { tone: "danger" });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading
        title="Saved replies"
        description="Replies you use often. Insert one from any comment box with the reply button in its toolbar."
        divider
      />
      {replies === null ? (
        <Skeleton width="100%" height={120} />
      ) : (
        <>
          {replies.length === 0 ? (
            <EmptyState bordered title="No saved replies yet" description="Add one below." />
          ) : (
            <ul className="mb-8 divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
              {replies.map((r) =>
                editing?.id === r.id ? (
                  <li key={r.id} className="p-4">
                    <ReplyForm token={token} reply={r} onSaved={(x) => saved(x, false)} onCancel={() => setEditing(null)} />
                  </li>
                ) : (
                  <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-fh-fg">{r.title}</p>
                      <p className="truncate text-fh-sm text-fh-fg-muted">{r.body}</p>
                    </div>
                    <Button size="sm" variant="default" onClick={() => setEditing(r)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>Delete</Button>
                  </li>
                ),
              )}
            </ul>
          )}
          <h2 className="mb-3 mt-8 text-fh-lg font-semibold text-fh-fg">Add a saved reply</h2>
          <ReplyForm key={replies.length} token={token} onSaved={(x) => saved(x, true)} />
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this saved reply?"
          message={`"${deleting.title}" will be gone from every comment box.`}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </SettingsLayout>
  );
}

function ReplyForm({ token, reply, onSaved, onCancel }: { token: string; reply?: SavedReply; onSaved: (r: SavedReply) => void; onCancel?: () => void }) {
  const [title, setTitle] = useState(reply?.title ?? "");
  const [body, setBody] = useState(reply?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(reply ? await updateSavedReply(token, reply.id, title, body) : await createSavedReply(token, title, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Saved reply title" htmlFor={reply ? `reply-title-${reply.id}` : "reply-title-new"}>
        {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Add a short title" />}
      </Field>
      <MarkdownEditor value={body} onValueChange={setBody} onSubmit={() => void submit()} placeholder="Add your saved reply" ariaLabel="Saved reply" />
      {error && <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="default" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={!title.trim() || !body.trim()}>
          {reply ? "Update saved reply" : "Add saved reply"}
        </Button>
      </div>
    </form>
  );
}
