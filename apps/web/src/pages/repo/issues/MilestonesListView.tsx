import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button, ConfirmDialog, cx, Dialog, EmptyState, RelativeTime, Spinner, Textarea, TextInput, useToast,
} from "../../../ui";
import {
  createMilestone, deleteMilestone, listMilestones, listRepoMembers, RepoMember, updateMilestone,
} from "../../../api";
import type { Milestone, User } from "../../../types";
import { MilestoneProgress } from "./Sidebar";
import { ChevronLeftIcon, MilestoneIcon } from "./icons";

/** ISO datetime → the `YYYY-MM-DD` a native date input expects. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function dueLabel(m: Milestone): { text: string; overdue: boolean } {
  if (!m.dueOn) return { text: "No due date", overdue: false };
  const d = new Date(m.dueOn);
  if (Number.isNaN(d.getTime())) return { text: "No due date", overdue: false };
  const nice = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const overdue = m.state === "open" && d.getTime() < Date.now();
  return { text: overdue ? `Past due by ${nice}` : `Due by ${nice}`, overdue };
}

type FormState = { number: number | null; title: string; description: string; dueOn: string };
const EMPTY_FORM: FormState = { number: null, title: "", description: "", dueOn: "" };

export function MilestonesListView({ token, handle, repoName, user }: {
  token: string; handle: string; repoName: string; user: User;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const { toast } = useToast();

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [counts, setCounts] = useState<{ open: number; closed: number }>({ open: 0, closed: 0 });
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"open" | "closed">("open");

  // Create / edit dialog.
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirmation.
  const [toDelete, setToDelete] = useState<Milestone | null>(null);
  const [deleting, setDeleting] = useState(false);

  function reload() {
    setLoading(true);
    setError(null);
    Promise.all([
      listMilestones(token, handle, repoName, "all"),
      listRepoMembers(token, handle, repoName).catch(() => ({ members: [] })),
    ])
      .then(([ms, mem]) => {
        setMilestones(ms.milestones);
        setCounts(ms.counts);
        setMembers(mem.members);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load milestones"))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [token, handle, repoName]);

  const isWriter =
    members.some((m) => m.handle === user.handle && (m.role === "owner" || m.role === "writer")) || handle === user.handle;

  const visible = milestones.filter((m) => m.state === state);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }
  function openEdit(m: Milestone) {
    setForm({ number: m.number, title: m.title, description: m.description ?? "", dueOn: toDateInput(m.dueOn) });
    setFormError(null);
    setFormOpen(true);
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    setFormError(null);
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      dueOn: form.dueOn ? form.dueOn : null,
    };
    try {
      if (form.number == null) {
        await createMilestone(token, handle, repoName, payload);
        toast("Milestone created", { tone: "success" });
      } else {
        await updateMilestone(token, handle, repoName, form.number, payload);
        toast("Milestone updated", { tone: "success" });
      }
      setFormOpen(false);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't save this milestone");
    } finally {
      setSaving(false);
    }
  }

  async function toggleState(m: Milestone) {
    try {
      await updateMilestone(token, handle, repoName, m.number, { state: m.state === "open" ? "closed" : "open" });
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update milestone", { tone: "warning" });
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteMilestone(token, handle, repoName, toDelete.number);
      toast("Milestone deleted", { tone: "success" });
      setToDelete(null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't delete milestone", { tone: "warning" });
    } finally {
      setDeleting(false);
    }
  }

  const toggle = (
    <div className="flex items-center gap-4">
      {([
        ["open", counts.open, "Open"],
        ["closed", counts.closed, "Closed"],
      ] as const).map(([s, count, text]) => (
        <button
          key={s}
          type="button"
          onClick={() => setState(s)}
          className={cx(
            "inline-flex items-center gap-1.5 text-fh-sm transition-colors",
            state === s ? "font-semibold text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg",
          )}
          aria-pressed={state === s}
        >
          <MilestoneIcon size={16} />
          <span>{count}</span>
          <span>{text}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <Link
          to={`${base}/issues`}
          className="inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg"
        >
          <ChevronLeftIcon size={14} />
          Issues
        </Link>
        {isWriter && <Button variant="primary" onClick={openCreate}>New milestone</Button>}
      </div>

      <div className="border border-fh-border rounded-md">
        <div className="flex items-center justify-between px-4 py-2.5 bg-fh-surface-muted border-b border-fh-border rounded-t-md">
          {toggle}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 bg-fh-surface rounded-b-md">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <div className="py-12 bg-fh-surface rounded-b-md">
            <EmptyState title="Couldn't load milestones" description={error} />
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-fh-surface rounded-b-md">
            <EmptyState
              icon={<MilestoneIcon size={28} />}
              title={state === "open" ? "No open milestones" : "No closed milestones"}
              description={
                state === "open"
                  ? "Group issues and pull requests into a deliverable with a due date and a progress bar."
                  : "Milestones you close will show up here."
              }
              actions={isWriter && state === "open" ? <Button variant="primary" onClick={openCreate}>New milestone</Button> : undefined}
            />
          </div>
        ) : (
          <ul className="divide-y divide-fh-border bg-fh-surface rounded-b-md overflow-hidden">
            {visible.map((m) => {
              const due = dueLabel(m);
              return (
                <li key={m.id} className="flex items-start gap-3 px-4 py-4">
                  <span className="mt-0.5 shrink-0 text-fh-fg-subtle"><MilestoneIcon size={16} /></span>
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`${base}/issues/milestones/${m.number}`}
                      className="text-fh-lg font-semibold text-fh-fg hover:text-fh-accent-fg"
                    >
                      {m.title}
                    </Link>
                    <div className="mt-0.5 text-fh-sm">
                      <span className={cx(due.overdue ? "text-fh-danger-fg font-medium" : "text-fh-fg-muted")}>{due.text}</span>
                      <span className="text-fh-fg-subtle"> · Last updated <RelativeTime date={m.updatedAt} /></span>
                    </div>
                    <div className="mt-2 max-w-md">
                      <MilestoneProgress percent={m.percent} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-fh-sm text-fh-fg-muted">
                      <span className="font-semibold text-fh-fg">{m.percent}%</span>
                      <span>{m.openItems} open</span>
                      <span>{m.closedItems} closed</span>
                    </div>
                    {m.description && (
                      <p className="mt-1.5 text-fh-sm text-fh-fg-muted line-clamp-2">{m.description}</p>
                    )}
                  </div>
                  {isWriter && (
                    <div className="flex items-center gap-1 shrink-0 text-fh-sm">
                      <button
                        type="button"
                        onClick={() => openEdit(m)}
                        className="px-2 py-1 rounded text-fh-fg-muted hover:text-fh-accent-fg hover:bg-fh-surface-muted transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleState(m)}
                        className="px-2 py-1 rounded text-fh-fg-muted hover:text-fh-fg hover:bg-fh-surface-muted transition-colors"
                      >
                        {m.state === "open" ? "Close" : "Reopen"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setToDelete(m)}
                        className="px-2 py-1 rounded text-fh-fg-muted hover:text-fh-danger-fg hover:bg-fh-danger-muted transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={form.number == null ? "New milestone" : "Edit milestone"}
        size="sm"
        footer={
          <>
            <Button variant="default" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!form.title.trim()} onClick={submitForm}>
              {form.number == null ? "Create milestone" : "Save changes"}
            </Button>
          </>
        }
      >
        <form onSubmit={submitForm} className="space-y-3">
          <div>
            <label htmlFor="ms-title" className="block text-fh-sm font-medium text-fh-fg mb-1">Title</label>
            <TextInput
              id="ms-title"
              placeholder="e.g. v1.0"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="ms-due" className="block text-fh-sm font-medium text-fh-fg mb-1">Due date (optional)</label>
            <TextInput
              id="ms-due"
              type="date"
              value={form.dueOn}
              onChange={(e) => setForm((f) => ({ ...f, dueOn: e.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="ms-desc" className="block text-fh-sm font-medium text-fh-fg mb-1">Description (optional)</label>
            <Textarea
              id="ms-desc"
              rows={3}
              placeholder="What is this milestone about?"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          {formError && <p className="text-fh-sm text-fh-danger-fg">{formError}</p>}
        </form>
      </Dialog>

      {toDelete && (
        <ConfirmDialog
          title="Delete milestone"
          message={<>Delete the milestone <span className="font-semibold">{toDelete.title}</span>? Issues and pull requests keep existing — they are only removed from this milestone.</>}
          confirmLabel="Delete milestone"
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}
