import { useEffect, useState } from "react";
import {
  addCollaborator, Collaborator, createLabel, deleteLabel, getRepo, getTopics,
  listCollaborators, listLabels, removeCollaborator, updateLabel, updateTopics,
} from "../../api";
import { UserSearchInput } from "../../components/UserSearchInput";
import type { Label, Repo, SearchUserResult, User } from "../../types";
import {
  Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, LabelChip,
  RelativeTime, Select, Skeleton, TextInput, cx, useToast,
} from "../../ui";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
};

// ── local Octicon-style marks ─────────────────────────────────────────────────

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const GEAR = "M8 0a8.2 8.2 0 00-.701.031C6.444.095 5.99.645 5.99 1.16v.702c0 .132-.052.263-.157.365a.855.855 0 01-.36.209l-.61.163a.86.86 0 01-.415-.001.844.844 0 01-.352-.211l-.496-.496a1.03 1.03 0 00-1.319-.111 8.02 8.02 0 00-.99.99 1.03 1.03 0 00.111 1.319l.496.496c.093.092.16.216.209.351a.86.86 0 010 .416l-.163.61a.855.855 0 01-.209.36.855.855 0 01-.365.157h-.702C.645 6.99.095 7.444.031 8.299a8.2 8.2 0 000 1.402c.064.855.614 1.309 1.129 1.309h.702c.132 0 .263.052.365.157.102.102.16.228.209.36l.163.61a.86.86 0 010 .416.844.844 0 01-.209.351l-.496.496a1.03 1.03 0 00-.111 1.319c.298.373.63.703.99.99a1.03 1.03 0 001.319-.111l.496-.496a.844.844 0 01.351-.209.86.86 0 01.416 0l.61.163c.132.049.258.107.36.209.105.102.157.233.157.365v.702c0 .515.454 1.065 1.309 1.129a8.2 8.2 0 001.402 0c.855-.064 1.309-.614 1.309-1.129v-.702c0-.132.052-.263.157-.365a.855.855 0 01.36-.209l.61-.163a.86.86 0 01.416 0c.135.049.259.116.351.209l.496.496a1.03 1.03 0 001.319.111c.373-.298.703-.63.99-.99a1.03 1.03 0 00-.111-1.319l-.496-.496a.844.844 0 01-.209-.351.86.86 0 010-.416l.163-.61a.855.855 0 01.209-.36.855.855 0 01.365-.157h.702c.515 0 1.065-.454 1.129-1.309a8.2 8.2 0 000-1.402c-.064-.855-.614-1.309-1.129-1.309h-.702a.855.855 0 01-.365-.157.855.855 0 01-.209-.36l-.163-.61a.86.86 0 010-.416.844.844 0 01.209-.351l.496-.496a1.03 1.03 0 00.111-1.319 8.02 8.02 0 00-.99-.99 1.03 1.03 0 00-1.319.111l-.496.496a.844.844 0 01-.351.209.86.86 0 01-.416 0l-.61-.163a.855.855 0 01-.36-.209.855.855 0 01-.157-.365V1.16c0-.515-.454-1.065-1.309-1.129A8.2 8.2 0 008 0zm0 4.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7z";
const PEOPLE = "M5.5 3.5a2 2 0 100 4 2 2 0 000-4zM2 5.5a3.5 3.5 0 115.898 2.549 5.508 5.508 0 013.034 4.084.75.75 0 11-1.482.235 4 4 0 00-7.9 0 .75.75 0 01-1.482-.236A5.507 5.507 0 013.102 8.05 3.49 3.49 0 012 5.5zM11 4a.75.75 0 100 1.5 1.5 1.5 0 01.666 2.844.75.75 0 00-.416.672c0 .29.163.56.416.672a4.5 4.5 0 012.415 4.058.75.75 0 001.5.001c0-1.883-.911-3.552-2.319-4.599A3 3 0 0011 4z";
const LABEL = "M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z";
const BOOKMARK = "M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 01-1.227.579L8 11.722l-3.773 3.107A.751.751 0 013 14.25V2.75zm1.75-.25a.25.25 0 00-.25.25v9.91l3.023-2.489a.75.75 0 01.954 0l3.023 2.49V2.75a.25.25 0 00-.25-.25h-6.5z";
const ALERT = "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575zm1.763.707a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368zm.53 3.996v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 011.5 0zM9 11a1 1 0 11-2 0 1 1 0 012 0z";

/** Normalize free text into a lowercase-kebab topic slug (server-validated too). */
function normalizeTopic(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 35);
}

const ROLE_LABEL: Record<Collaborator["role"], string> = {
  reader: "Reader", writer: "Writer", admin: "Admin",
};

// ── section shell ─────────────────────────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="pb-3 mb-4 border-b border-fh-border">
      <h2 className="text-fh-lg font-semibold text-fh-fg">{title}</h2>
      {description && <p className="text-fh-sm text-fh-fg-muted mt-0.5">{description}</p>}
    </div>
  );
}

// ── General ───────────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-1 sm:gap-4 px-4 py-3">
      <dt className="text-fh-sm font-semibold text-fh-fg">{label}</dt>
      <dd className="text-fh-base text-fh-fg-muted min-w-0">{children}</dd>
    </div>
  );
}

function GeneralSection({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getRepo(token, handle, repoName)
      .then(setRepo)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  return (
    <div>
      <SectionHeader title="General" description="Details about this repository." />
      {loading ? (
        <div className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : repo ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <div className="flex items-center gap-3 px-4 py-4 border-b border-fh-border">
            <Avatar name={repo.name} size={40} square />
            <div className="min-w-0">
              <p className="text-fh-lg font-semibold text-fh-fg flex items-center gap-2">
                <span className="truncate">{repo.fullName}</span>
                <Badge tone="neutral">
                  {repo.visibility === "public" ? "Public" : "Private"}
                </Badge>
              </p>
              <p className="text-fh-sm text-fh-fg-muted mt-0.5">
                {repo.description || <span className="italic text-fh-fg-subtle">No description</span>}
              </p>
            </div>
          </div>
          <dl className="divide-y divide-fh-border">
            <InfoRow label="Repository name"><span className="font-mono text-fh-fg">{repo.name}</span></InfoRow>
            <InfoRow label="Owner"><span className="font-mono text-fh-fg">@{repo.ownerHandle}</span></InfoRow>
            <InfoRow label="Visibility">{repo.visibility === "public" ? "Public — anyone can see this repository." : "Private — only you and collaborators can see it."}</InfoRow>
            <InfoRow label="Created"><RelativeTime date={repo.createdAt} /></InfoRow>
            <InfoRow label="Last updated"><RelativeTime date={repo.updatedAt} /></InfoRow>
          </dl>
        </div>
      ) : (
        <p className="text-fh-sm text-fh-fg-muted">Could not load repository details.</p>
      )}
    </div>
  );
}

// ── Collaborators ─────────────────────────────────────────────────────────────

function CollaboratorsSection({ token, repoName }: { token: string; repoName: string }) {
  const [collabs, setCollabs] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SearchUserResult | null>(null);
  const [role, setRole] = useState<Collaborator["role"]>("writer");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Collaborator | null>(null);
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    listCollaborators(token, repoName)
      .then((d) => setCollabs(d.collaborators))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, repoName]);

  function upsert(c: Collaborator) {
    setCollabs((prev) => {
      const i = prev.findIndex((x) => x.user.handle === c.user.handle);
      if (i >= 0) { const next = [...prev]; next[i] = c; return next; }
      return [...prev, c];
    });
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setAdding(true);
    setError(null);
    try {
      const c = await addCollaborator(token, repoName, selected.handle, role);
      upsert(c);
      setSelected(null);
      toast(`Added @${c.user.handle}`, { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add collaborator");
    } finally {
      setAdding(false);
    }
  }

  async function changeRole(c: Collaborator, next: Collaborator["role"]) {
    if (next === c.role) return;
    setSavingId(c.id);
    try {
      const updated = await addCollaborator(token, repoName, c.user.handle, next);
      upsert(updated);
      toast(`@${c.user.handle} is now a ${ROLE_LABEL[next].toLowerCase()}`, { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to change role", { tone: "danger" });
    } finally {
      setSavingId(null);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      await removeCollaborator(token, repoName, pendingRemove.user.handle);
      setCollabs((prev) => prev.filter((c) => c.id !== pendingRemove.id));
      toast(`Removed @${pendingRemove.user.handle}`, { tone: "success" });
      setPendingRemove(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove collaborator", { tone: "danger" });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Collaborators" description="People with access to this repository beyond you." />

      {/* Add collaborator */}
      <form onSubmit={add} className="bg-fh-surface border border-fh-border rounded-md p-4 mb-4">
        <p className="text-fh-sm font-semibold text-fh-fg mb-3">Add a collaborator</p>
        {selected ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-2 bg-fh-surface-muted border border-fh-border rounded-full pl-1 pr-2 py-1">
              <Avatar name={selected.displayName || selected.handle} size={22} />
              <span className="text-fh-sm font-medium text-fh-fg">{selected.displayName || selected.handle}</span>
              <span className="text-fh-xs text-fh-fg-muted">@{selected.handle}</span>
              <button type="button" aria-label="Clear selection" onClick={() => setSelected(null)}
                className="ml-0.5 text-fh-fg-muted hover:text-fh-danger-fg cursor-pointer">
                <Icon size={12} path="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </button>
            </span>
            <div className="w-32">
              <Select value={role} onChange={(e) => setRole(e.target.value as Collaborator["role"])} aria-label="Role">
                <option value="reader">Reader</option>
                <option value="writer">Writer</option>
                <option value="admin">Admin</option>
              </Select>
            </div>
            <Button variant="primary" type="submit" loading={adding}>Add collaborator</Button>
          </div>
        ) : (
          <UserSearchInput token={token} onSelect={setSelected} />
        )}
        {error && <p className="text-fh-sm text-fh-danger-fg mt-2">{error}</p>}
        <p className="text-fh-xs text-fh-fg-muted mt-3">
          <span className="font-semibold text-fh-fg-muted">Reader</span> can view ·{" "}
          <span className="font-semibold text-fh-fg-muted">Writer</span> can push and open issues/PRs ·{" "}
          <span className="font-semibold text-fh-fg-muted">Admin</span> can manage settings.
        </p>
      </form>

      {/* List */}
      {loading ? (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton variant="block" width={32} height={32} className="rounded-full" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      ) : collabs.length === 0 ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <EmptyState
            icon={<Icon path={PEOPLE} size={28} />}
            title="No collaborators yet"
            description="Add someone above to give them access to this repository."
          />
        </div>
      ) : (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {collabs.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={c.user.displayName || c.user.handle} size={32} />
              <div className="flex-1 min-w-0">
                <p className="text-fh-sm font-semibold text-fh-fg truncate">{c.user.displayName || c.user.handle}</p>
                <p className="text-fh-xs text-fh-fg-muted truncate">@{c.user.handle}</p>
              </div>
              <div className="w-28">
                <Select
                  sizing="sm"
                  value={c.role}
                  disabled={savingId === c.id}
                  onChange={(e) => void changeRole(c, e.target.value as Collaborator["role"])}
                  aria-label={`Role for ${c.user.handle}`}
                >
                  <option value="reader">Reader</option>
                  <option value="writer">Writer</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>
              <Button variant="danger" size="sm" onClick={() => setPendingRemove(c)}>Remove</Button>
            </div>
          ))}
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="Remove collaborator"
          message={<>Remove <span className="font-semibold">@{pendingRemove.user.handle}</span> from this repository? They will immediately lose access.</>}
          confirmLabel="Remove"
          loading={removing}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}

// ── Labels ────────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  "d73a4a", "0b7fab", "0b6f96", "e4e669", "a2eeef",
  "7a44d6", "137a4b", "e11d48", "fb923c", "84cc16",
  "06b6d4", "8b5cf6",
];

function LabelForm({ initial, onSave, onCancel }: {
  initial?: Label;
  onSave: (name: string, color: string, desc: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? PRESET_COLORS[0]);
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || color.length !== 6) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim(), color, desc.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save label");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-fh-sm font-semibold text-fh-fg">Preview</span>
        <LabelChip name={name || "label preview"} color={color.length === 6 ? color : "cccccc"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Name" required>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="bug, enhancement…" />}
        </Field>
        <Field label="Description">
          {(id) => <TextInput id={id} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" />}
        </Field>
        <Field label="Color">
          {(id) => (
            <div className="flex items-center gap-2">
              <TextInput id={id} value={color} maxLength={6} className="w-24 font-mono"
                onChange={(e) => setColor(e.target.value.replace("#", "").slice(0, 6))} placeholder="d73a4a" />
              <span className="w-8 h-8 rounded-md border border-fh-border shrink-0"
                style={{ backgroundColor: `#${color.length === 6 ? color : "cccccc"}` }} aria-hidden="true" />
            </div>
          )}
        </Field>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {PRESET_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Use #${c}`}
            className={cx("w-6 h-6 rounded-md border-2 transition-transform hover:scale-110",
              color === c ? "border-fh-fg" : "border-transparent")}
            style={{ backgroundColor: `#${c}` }} />
        ))}
      </div>
      {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      <div className="flex justify-end gap-2 pt-1 border-t border-fh-border">
        <Button variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!name.trim() || color.length !== 6}>
          {initial ? "Save changes" : "Create label"}
        </Button>
      </div>
    </form>
  );
}

function LabelsSection({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Label | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    listLabels(token, handle, repoName)
      .then((d) => setLabels(d.labels))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  async function handleCreate(name: string, color: string, description: string) {
    const lbl = await createLabel(token, handle, repoName, name, color, description || undefined);
    setLabels((prev) => [...prev, lbl]);
    setShowNew(false);
    toast("Label created", { tone: "success" });
  }

  async function handleUpdate(id: string, name: string, color: string, description: string) {
    const lbl = await updateLabel(token, handle, repoName, id, { name, color, description: description || undefined });
    setLabels((prev) => prev.map((l) => (l.id === id ? lbl : l)));
    setEditing(null);
    toast("Label updated", { tone: "success" });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteLabel(token, handle, repoName, pendingDelete.id);
      setLabels((prev) => prev.filter((l) => l.id !== pendingDelete.id));
      toast("Label deleted", { tone: "success" });
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete label", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-4 pb-3 mb-4 border-b border-fh-border">
        <div>
          <h2 className="text-fh-lg font-semibold text-fh-fg">Labels</h2>
          <p className="text-fh-sm text-fh-fg-muted mt-0.5">Organize and categorize issues and pull requests.</p>
        </div>
        {!showNew && <Button variant="primary" onClick={() => setShowNew(true)}>New label</Button>}
      </div>

      {showNew && <div className="mb-4"><LabelForm onSave={handleCreate} onCancel={() => setShowNew(false)} /></div>}

      {loading ? (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      ) : labels.length === 0 && !showNew ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <EmptyState icon={<Icon path={LABEL} size={28} />} title="No labels yet"
            description="Create your first label to triage issues and pull requests." />
        </div>
      ) : (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {labels.map((label) => (
            <div key={label.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="w-40 shrink-0"><LabelChip name={label.name} color={label.color} /></div>
                <span className="text-fh-sm text-fh-fg-muted flex-1 min-w-0 truncate">
                  {label.description || <span className="italic text-fh-fg-subtle">No description</span>}
                </span>
                <Button variant="invisible" size="sm" onClick={() => setEditing(editing === label.id ? null : label.id)}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => setPendingDelete(label)}>Delete</Button>
              </div>
              {editing === label.id && (
                <div className="px-4 pb-4">
                  <LabelForm initial={label}
                    onSave={(name, color, desc) => handleUpdate(label.id, name, color, desc)}
                    onCancel={() => setEditing(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete label"
          message={<>Delete the <LabelChip name={pendingDelete.name} color={pendingDelete.color} /> label? It will be removed from every issue and pull request.</>}
          confirmLabel="Delete label"
          loading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// ── Topics ────────────────────────────────────────────────────────────────────

const MAX_TOPICS = 20;

function TopicsSection({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const [topics, setTopics] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    getTopics(token, handle, repoName)
      .then((d) => setTopics(d.topics))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  function addTopic() {
    const slug = normalizeTopic(input);
    if (!slug) return;
    if (topics.includes(slug)) {
      setInput("");
      return;
    }
    if (topics.length >= MAX_TOPICS) {
      toast(`Up to ${MAX_TOPICS} topics`, { tone: "warning" });
      return;
    }
    setTopics((prev) => [...prev, slug]);
    setInput("");
    setDirty(true);
  }

  function removeTopic(t: string) {
    setTopics((prev) => prev.filter((x) => x !== t));
    setDirty(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && input.trim())) {
      e.preventDefault();
      addTopic();
    } else if (e.key === "Backspace" && !input && topics.length > 0) {
      removeTopic(topics[topics.length - 1]);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const d = await updateTopics(token, handle, repoName, topics);
      setTopics(d.topics);
      setDirty(false);
      toast("Topics saved", { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save topics", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Topics" description="Describe this repository with topics so people can find it. Topics are public and searchable." />

      {loading ? (
        <div className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-3">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-fh-border bg-fh-surface-inset px-2.5 py-2 min-h-[40px]">
            {topics.length === 0 && !input && (
              <span className="text-fh-sm text-fh-fg-subtle px-1">No topics yet — add one below.</span>
            )}
            {topics.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-fh-accent-muted pl-2.5 pr-1.5 py-0.5 text-fh-xs font-medium text-fh-accent-fg"
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => removeTopic(t)}
                  className="inline-flex items-center justify-center rounded-full text-fh-accent-fg/70 hover:text-fh-danger-fg cursor-pointer"
                >
                  <Icon size={12} path="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <Field label="Add a topic" hint="Lowercase letters, numbers, and single hyphens (e.g. 3d-printing).">
                {(id) => (
                  <TextInput
                    id={id}
                    value={input}
                    placeholder="gltf, cad, semantic-diff…"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={() => input.trim() && addTopic()}
                    disabled={topics.length >= MAX_TOPICS}
                  />
                )}
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="default" onClick={addTopic} disabled={!normalizeTopic(input) || topics.length >= MAX_TOPICS}>
                Add
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-fh-border">
            <p className="text-fh-xs text-fh-fg-subtle">
              {topics.length}/{MAX_TOPICS} topics
            </p>
            <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
              Save topics
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────────

function DangerSection({ repoName, fullName }: { repoName: string; fullName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const { toast } = useToast();
  const matches = typed.trim() === repoName;

  function close() { setConfirming(false); setTyped(""); }

  function requestDelete() {
    if (!matches) return;
    // Repository deletion needs a server wrapper that isn't exposed in this
    // build (src/api.ts has no deleteRepo). Keep the flow honest.
    toast("Repository deletion isn't available in this build yet.", { tone: "warning" });
    close();
  }

  return (
    <div>
      <SectionHeader title="Danger zone" description="Irreversible and destructive actions." />
      <div className="rounded-md border border-fh-danger-emphasis/40 divide-y divide-fh-danger-emphasis/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-4">
          <div className="min-w-0">
            <p className="text-fh-base font-semibold text-fh-fg">Delete this repository</p>
            <p className="text-fh-sm text-fh-fg-muted mt-0.5">
              Once deleted, there is no going back. This permanently removes the code, issues, and releases.
            </p>
          </div>
          <Button variant="danger" leadingIcon={<Icon path={ALERT} size={14} />} onClick={() => setConfirming(true)}>
            Delete this repository
          </Button>
        </div>
      </div>

      <Dialog
        open={confirming}
        onClose={close}
        size="sm"
        title="Delete this repository?"
        footer={
          <>
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button variant="danger" disabled={!matches} onClick={requestDelete}>Delete this repository</Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-fh-base text-fh-fg leading-normal">
            This permanently deletes <span className="font-mono font-semibold">{fullName}</span>,
            along with its issues, releases, and history. This cannot be undone.
          </p>
          <div className="flex items-start gap-2 rounded-md border border-fh-warning-emphasis/30 bg-fh-warning-muted px-3 py-2 text-fh-sm text-fh-warning-fg">
            <span aria-hidden className="mt-px font-bold">!</span>
            <span>Deleting a repository removes it for every collaborator, permanently.</span>
          </div>
          <Field label="Confirm the repository name" hint={<>Type <span className="font-mono font-semibold text-fh-fg">{repoName}</span> to enable deletion.</>}>
            {(id) => <TextInput id={id} value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" autoFocus />}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

type SectionKey = "general" | "topics" | "collaborators" | "labels" | "danger";

export function RepoSettingsTab({ token, handle, repoName }: Props) {
  const [section, setSection] = useState<SectionKey>("general");
  const fullName = `${handle}/${repoName}`;

  const nav: { key: SectionKey; label: string; icon: string; danger?: boolean }[] = [
    { key: "general", label: "General", icon: GEAR },
    { key: "topics", label: "Topics", icon: BOOKMARK },
    { key: "collaborators", label: "Collaborators", icon: PEOPLE },
    { key: "labels", label: "Labels", icon: LABEL },
    { key: "danger", label: "Danger zone", icon: ALERT, danger: true },
  ];

  return (
    <div className="flex flex-col md:flex-row gap-6">
      {/* Section nav */}
      <nav className="md:w-52 shrink-0" aria-label="Settings">
        <ul className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">
          {nav.map((s) => {
            const active = section === s.key;
            return (
              <li key={s.key} className="shrink-0">
                <button
                  onClick={() => setSection(s.key)}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-fh-base rounded-md whitespace-nowrap transition-colors cursor-pointer text-left",
                    active
                      ? s.danger
                        ? "font-semibold text-fh-danger-fg bg-fh-danger-muted"
                        : "font-semibold text-fh-fg bg-fh-surface-muted"
                      : s.danger
                        ? "text-fh-danger-fg hover:bg-fh-danger-muted"
                        : "text-fh-fg-muted hover:text-fh-fg hover:bg-fh-surface-muted",
                  )}
                >
                  <span className={cx("inline-flex shrink-0", active && !s.danger ? "text-fh-fg" : undefined)}>
                    <Icon path={s.icon} size={16} />
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {section === "general" && <GeneralSection token={token} handle={handle} repoName={repoName} />}
        {section === "topics" && <TopicsSection token={token} handle={handle} repoName={repoName} />}
        {section === "collaborators" && <CollaboratorsSection token={token} repoName={repoName} />}
        {section === "labels" && <LabelsSection token={token} handle={handle} repoName={repoName} />}
        {section === "danger" && <DangerSection repoName={repoName} fullName={fullName} />}
      </div>
    </div>
  );
}
