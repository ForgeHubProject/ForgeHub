import { useEffect, useState } from "react";
import {
  addCollaborator, addDeployKey, Collaborator, createLabel, createWebhook, deleteBranchProtection, deleteDeployKey, deleteLabel, deleteWebhook,
  getBranchProtection, getRepo, getTopics, listBranches, listCollaborators, listDeployKeys, listLabels, listWebhooks, listWebhookDeliveries,
  putBranchProtection, redeliverWebhookDelivery, removeCollaborator, updateLabel, updateTopics, updateWebhook,
} from "../../api";
import { UserSearchInput } from "../../components/UserSearchInput";
import type {
  BranchInfo, BranchProtectionRules, DeployKey, Label, Repo, SearchUserResult, User, Webhook, WebhookDelivery, WebhookEvent,
} from "../../types";
import {
  Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, LabelChip,
  RelativeTime, Select, Skeleton, Spinner, TextInput, Textarea, cx, useToast,
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
const WEBHOOK = "M8.5 4.5a1.5 1.5 0 00-1.415 2A.75.75 0 015.67 7.003 3 3 0 118.5 9c-.257 0-.505-.032-.742-.093l-1.86 3.196A2.5 2.5 0 114.5 11.5c.086 0 .17.004.253.013l.867-1.49A.75.75 0 016.914 10.8l-.867 1.49c.257.27.453.6.567.966H10.5a.75.75 0 010 1.5H6.61a2.5 2.5 0 11-1.06-4.386l1.767-3.037A.75.75 0 017.9 6.976 1.5 1.5 0 108.5 4.5zm-4 7.5a1 1 0 100 2 1 1 0 000-2zm7.5-1.5a2.5 2.5 0 10-2.45 2.5.75.75 0 000-1.5A1 1 0 1112 10.5a.75.75 0 001.5 0z";
const BRANCH = "M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z";
const KEY = "M10.5 0a5.499 5.499 0 00-5.243 7.148L.436 11.97a1.489 1.489 0 00-.436 1.053v1.487C0 15.328.672 16 1.5 16h1.487c.395 0 .774-.157 1.054-.436l.31-.311a.75.75 0 00.22-.53v-.807h.807a.75.75 0 00.53-.22l.716-.716a.75.75 0 00.22-.53v-.807h.462l4.822-4.821A5.499 5.499 0 0010.5 0zm1.5 4.75a1 1 0 11-2 0 1 1 0 012 0z";

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

// ── Webhooks ──────────────────────────────────────────────────────────────────

const EVENT_OPTIONS: { value: WebhookEvent; label: string; hint: string }[] = [
  { value: "push", label: "Push", hint: "Commits pushed to any branch" },
  { value: "issues", label: "Issues", hint: "Issue opened, closed, reopened, labeled…" },
  { value: "issue_comment", label: "Issue comments", hint: "A comment is added to an issue" },
  { value: "pull_request", label: "Pull requests", hint: "PR opened, closed, or merged" },
  { value: "release", label: "Releases", hint: "A release is published" },
];

const EVENT_LABEL: Record<string, string> = {
  "*": "all events", push: "push", issues: "issues", issue_comment: "issue_comment", pull_request: "pull_request", release: "release",
};

function eventChips(events: (WebhookEvent | "*")[]) {
  if (events.includes("*")) return ["all events"];
  return events.map((e) => EVENT_LABEL[e] ?? e);
}

/** A delivery's HTTP status as a colored chip. */
function DeliveryStatusChip({ d }: { d: WebhookDelivery }) {
  if (d.ok) return <Badge tone="success">{d.statusCode ?? "OK"}</Badge>;
  if (d.statusCode != null) return <Badge tone="danger">{d.statusCode}</Badge>;
  return <Badge tone="danger">failed</Badge>;
}

function DeliveriesPanel({ token, handle, repoName, hookId }: {
  token: string; handle: string; repoName: string; hookId: string;
}) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const { toast } = useToast();

  function load() {
    listWebhookDeliveries(token, handle, repoName, hookId)
      .then((d) => setDeliveries(d.deliveries))
      .catch(() => setDeliveries([]));
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, handle, repoName, hookId]);

  async function redeliver(id: string) {
    setRedelivering(id);
    try {
      await redeliverWebhookDelivery(token, handle, repoName, hookId, id);
      toast("Redelivered", { tone: "success" });
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Redeliver failed", { tone: "danger" });
    } finally {
      setRedelivering(null);
    }
  }

  if (deliveries === null) {
    return <div className="px-4 py-3 flex items-center gap-2 text-fh-sm text-fh-fg-muted"><Spinner size={14} /> Loading recent deliveries…</div>;
  }
  if (deliveries.length === 0) {
    return <p className="px-4 py-3 text-fh-sm text-fh-fg-subtle italic">No deliveries yet. Trigger a subscribed event to see attempts here.</p>;
  }
  return (
    <ul className="divide-y divide-fh-border">
      {deliveries.map((d) => (
        <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
          <DeliveryStatusChip d={d} />
          <div className="min-w-0 flex-1">
            <p className="text-fh-sm text-fh-fg flex items-center gap-1.5 flex-wrap">
              <code className="font-mono text-fh-xs bg-fh-surface-muted rounded px-1.5 py-0.5">{d.event}</code>
              {d.redeliveredFromId && <Badge tone="neutral">redelivered</Badge>}
              <span className="text-fh-xs text-fh-fg-subtle">{d.durationMs}ms · <RelativeTime date={d.createdAt} /></span>
            </p>
            {d.error && <p className="text-fh-xs text-fh-danger-fg truncate" title={d.error}>{d.error}</p>}
          </div>
          <Button variant="invisible" size="sm" loading={redelivering === d.id} onClick={() => void redeliver(d.id)}>
            Redeliver
          </Button>
        </li>
      ))}
    </ul>
  );
}

function WebhookForm({ onSave, onCancel }: {
  onSave: (input: { url: string; secret: string; events: WebhookEvent[]; active: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["push", "issues", "issue_comment", "pull_request", "release"]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEvent(e: WebhookEvent) {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!url.trim() || !secret.trim() || events.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ url: url.trim(), secret: secret.trim(), events, active });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-4 mb-4">
      <p className="text-fh-sm font-semibold text-fh-fg">Add a webhook</p>
      <Field label="Payload URL" required hint="We POST a signed JSON body here. Private/loopback targets are blocked unless the instance allows them.">
        {(id) => <TextInput id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" autoComplete="off" />}
      </Field>
      <Field label="Secret" required hint="Signs the X-ForgeHub-Signature-256 header (HMAC-SHA256). Stored write-only.">
        {(id) => <TextInput id={id} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="a strong shared secret" autoComplete="off" />}
      </Field>
      <div>
        <p className="text-fh-sm font-semibold text-fh-fg mb-2">Events</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {EVENT_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 rounded-md border border-fh-border px-3 py-2 cursor-pointer hover:bg-fh-surface-muted">
              <input type="checkbox" className="mt-0.5 accent-fh-accent-emphasis" checked={events.includes(opt.value)} onChange={() => toggleEvent(opt.value)} />
              <span className="min-w-0">
                <span className="block text-fh-sm font-medium text-fh-fg">{opt.label}</span>
                <span className="block text-fh-xs text-fh-fg-muted">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" className="accent-fh-accent-emphasis" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span className="text-fh-sm text-fh-fg">Active — deliver events immediately</span>
      </label>
      {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      <div className="flex justify-end gap-2 pt-1 border-t border-fh-border">
        <Button variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!url.trim() || !secret.trim() || events.length === 0}>
          Add webhook
        </Button>
      </div>
    </form>
  );
}

function WebhookRow({ token, handle, repoName, hook, onChange, onDelete }: {
  token: string; handle: string; repoName: string; hook: Webhook;
  onChange: (h: Webhook) => void; onDelete: (h: Webhook) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const { toast } = useToast();

  async function toggleActive() {
    setToggling(true);
    try {
      const updated = await updateWebhook(token, handle, repoName, hook.id, { active: !hook.active });
      onChange(updated);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update webhook", { tone: "danger" });
    } finally {
      setToggling(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span className={cx("shrink-0 mt-0.5", hook.active ? "text-fh-success-fg" : "text-fh-fg-subtle")}>
            <Icon path={WEBHOOK} size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-fh-sm font-mono text-fh-fg break-all">{hook.url}</p>
            <p className="text-fh-xs text-fh-fg-muted mt-0.5 flex items-center gap-1 flex-wrap">
              {eventChips(hook.events).map((e) => (
                <span key={e} className="inline-flex rounded-full bg-fh-surface-muted px-1.5 py-0.5 font-mono">{e}</span>
              ))}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {hook.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
          <Button variant="default" size="sm" loading={toggling} onClick={() => void toggleActive()}>
            {hook.active ? "Disable" : "Enable"}
          </Button>
          <Button variant="invisible" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide" : "Deliveries"}
          </Button>
          <Button variant="danger" size="sm" onClick={() => onDelete(hook)}>Delete</Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-fh-border bg-fh-surface-inset/40">
          <DeliveriesPanel token={token} handle={handle} repoName={repoName} hookId={hook.id} />
        </div>
      )}
    </div>
  );
}

function WebhooksSection({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    listWebhooks(token, handle, repoName)
      .then((d) => setHooks(d.hooks))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  async function handleCreate(input: { url: string; secret: string; events: WebhookEvent[]; active: boolean }) {
    const hook = await createWebhook(token, handle, repoName, input);
    setHooks((prev) => [hook, ...prev]);
    setShowNew(false);
    toast("Webhook created — a ping was sent", { tone: "success" });
  }

  function upsert(h: Webhook) {
    setHooks((prev) => prev.map((x) => (x.id === h.id ? h : x)));
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteWebhook(token, handle, repoName, pendingDelete.id);
      setHooks((prev) => prev.filter((h) => h.id !== pendingDelete.id));
      toast("Webhook deleted", { tone: "success" });
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete webhook", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-4 pb-3 mb-4 border-b border-fh-border">
        <div>
          <h2 className="text-fh-lg font-semibold text-fh-fg">Webhooks</h2>
          <p className="text-fh-sm text-fh-fg-muted mt-0.5">
            POST signed event payloads to an external URL. Each delivery is signed with HMAC-SHA256 and logged for debugging.
          </p>
        </div>
        {!showNew && <Button variant="primary" onClick={() => setShowNew(true)}>Add webhook</Button>}
      </div>

      {showNew && <WebhookForm onSave={handleCreate} onCancel={() => setShowNew(false)} />}

      {loading ? (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton variant="block" width={18} height={18} className="rounded" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      ) : hooks.length === 0 && !showNew ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <EmptyState
            icon={<Icon path={WEBHOOK} size={28} />}
            title="No webhooks yet"
            description="Add a webhook to notify an external service when this repository changes."
          />
        </div>
      ) : (
        hooks.length > 0 && (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {hooks.map((h) => (
              <WebhookRow key={h.id} token={token} handle={handle} repoName={repoName} hook={h} onChange={upsert} onDelete={setPendingDelete} />
            ))}
          </div>
        )
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete webhook"
          message={<>Delete the webhook to <span className="font-mono font-semibold break-all">{pendingDelete.url}</span>? Deliveries will stop immediately.</>}
          confirmLabel="Delete webhook"
          loading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// ── Branch protection (issue #85) ───────────────────────────────────────────────

const EMPTY_RULES: BranchProtectionRules = {
  requirePullRequest: false,
  requiredApprovals: 0,
  requireGreenChecks: false,
  blockForcePush: false,
};

function RuleToggle({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5 rounded-md border border-fh-border px-3 py-2.5 cursor-pointer hover:bg-fh-surface-muted">
      <input type="checkbox" className="mt-0.5 accent-fh-accent-emphasis" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-fh-sm font-medium text-fh-fg">{label}</span>
        <span className="block text-fh-xs text-fh-fg-muted">{hint}</span>
      </span>
    </label>
  );
}

/** Inline editor for one branch's protection rules (owner-gated by the caller). */
function ProtectionEditor({ token, handle, repoName, branch, wasProtected, onDone }: {
  token: string; handle: string; repoName: string; branch: string;
  wasProtected: boolean; onDone: (next: { protected: boolean; rules: BranchProtectionRules }) => void;
}) {
  const [rules, setRules] = useState<BranchProtectionRules>(EMPTY_RULES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let live = true;
    getBranchProtection(token, handle, repoName, branch)
      .then((d) => { if (live) setRules(d.rules); })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token, handle, repoName, branch]);

  function set<K extends keyof BranchProtectionRules>(key: K, value: BranchProtectionRules[K]) {
    setRules((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const d = await putBranchProtection(token, handle, repoName, branch, rules);
      toast(`Protection saved for ${branch}`, { tone: "success" });
      onDone({ protected: d.protected, rules: d.rules });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save protection");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await deleteBranchProtection(token, handle, repoName, branch);
      toast(`Protection removed from ${branch}`, { tone: "success" });
      onDone({ protected: false, rules: EMPTY_RULES });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove protection");
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-4 space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-3 bg-fh-surface-inset/40">
      <div className="grid gap-2 sm:grid-cols-2">
        <RuleToggle
          checked={rules.requirePullRequest}
          onChange={(v) => set("requirePullRequest", v)}
          label="Require a pull request before merging"
          hint="Blocks direct pushes to this branch — changes must land through a PR."
        />
        <RuleToggle
          checked={rules.blockForcePush}
          onChange={(v) => set("blockForcePush", v)}
          label="Block force pushes"
          hint="Rejects non-fast-forward (history-rewriting) pushes to this branch."
        />
        <RuleToggle
          checked={rules.requireGreenChecks}
          onChange={(v) => set("requireGreenChecks", v)}
          label="Require status checks to pass"
          hint="Blocks the merge until the head commit's checks are green (inert until CI is configured)."
        />
        <div className="rounded-md border border-fh-border px-3 py-2.5">
          <Field label="Required approving reviews" hint="Non-stale approvals needed to merge (0 = no approval gate).">
            {(id) => (
              <TextInput
                id={id}
                type="number"
                min={0}
                max={20}
                className="w-24"
                value={String(rules.requiredApprovals)}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0)));
                  set("requiredApprovals", n);
                }}
              />
            )}
          </Field>
        </div>
      </div>

      {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-fh-border">
        {wasProtected ? (
          <Button variant="danger" size="sm" loading={removing} disabled={saving} onClick={() => void remove()}>
            Remove protection
          </Button>
        ) : (
          <span className="text-fh-xs text-fh-fg-subtle">
            A protected branch cannot be deleted, even with no rules enabled.
          </span>
        )}
        <Button variant="primary" size="sm" loading={saving} disabled={removing} onClick={() => void save()}>
          {wasProtected ? "Save changes" : "Protect branch"}
        </Button>
      </div>
    </div>
  );
}

function BranchesSection({ token, handle, repoName, isOwner }: {
  token: string; handle: string; repoName: string; isOwner: boolean;
}) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    setBranches(null);
    listBranches(token, handle, repoName)
      .then((d) => setBranches(d.branches))
      .catch(() => setBranches([]));
  }, [token, handle, repoName]);

  function applyChange(branch: string, next: { protected: boolean }) {
    setBranches((prev) =>
      prev ? prev.map((b) => (b.name === branch ? { ...b, protected: next.protected } : b)) : prev,
    );
    setEditing(null);
  }

  return (
    <div>
      <SectionHeader
        title="Branch protection"
        description="Protect branches with enforced rules — require pull requests, approvals, or green checks, and block force-pushes."
      />

      {!isOwner && (
        <p className="mb-4 text-fh-sm text-fh-fg-muted rounded-md border border-fh-border bg-fh-surface px-4 py-3">
          Only the repository owner can change branch protection.
        </p>
      )}

      {branches === null ? (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton variant="block" width={16} height={16} className="rounded" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      ) : branches.length === 0 ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <EmptyState icon={<Icon path={BRANCH} size={28} />} title="No branches yet"
            description="Push a branch to this repository to configure protection." />
        </div>
      ) : (
        <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
          {branches.map((b) => {
            const isEditing = editing === b.name;
            return (
              <div key={b.name}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="shrink-0 text-fh-fg-muted"><Icon path={BRANCH} size={16} /></span>
                  <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                    <span className="text-fh-sm font-mono font-medium text-fh-fg truncate">{b.name}</span>
                    {b.isDefault && <Badge tone="accent">default</Badge>}
                    {b.protected && <Badge tone="success">protected</Badge>}
                  </div>
                  {isOwner && (
                    <Button
                      variant={isEditing ? "invisible" : "default"}
                      size="sm"
                      onClick={() => setEditing(isEditing ? null : b.name)}
                    >
                      {isEditing ? "Cancel" : b.protected ? "Edit" : "Protect"}
                    </Button>
                  )}
                </div>
                {isEditing && isOwner && (
                  <div className="border-t border-fh-border">
                    <ProtectionEditor
                      token={token}
                      handle={handle}
                      repoName={repoName}
                      branch={b.name}
                      wasProtected={b.protected}
                      onDone={(next) => applyChange(b.name, next)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Deploy keys (issue #116) ────────────────────────────────────────────────────

function DeployKeyForm({ onSave, onCancel }: {
  onSave: (input: { title: string; publicKey: string; readOnly: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !publicKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ title: title.trim(), publicKey: publicKey.trim(), readOnly });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add deploy key");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-4 mb-4">
      <p className="text-fh-sm font-semibold text-fh-fg">Add a deploy key</p>
      <Field label="Title" required hint="A memorable name for this key, e.g. the CI system that uses it.">
        {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. production deploy" autoComplete="off" />}
      </Field>
      <Field label="Key" required hint="Paste a public key line ('ssh-ed25519 …', 'ssh-rsa …').">
        {(id) => (
          <Textarea id={id} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} rows={4}
            className="font-mono text-fh-xs" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... deploy@ci" />
        )}
      </Field>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5 accent-fh-accent-emphasis" checked={!readOnly} onChange={(e) => setReadOnly(!e.target.checked)} />
        <span className="min-w-0">
          <span className="block text-fh-sm font-medium text-fh-fg">Allow write access</span>
          <span className="block text-fh-xs text-fh-fg-muted">By default a deploy key can only clone/pull. Enable this to let it push.</span>
        </span>
      </label>
      {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      <div className="flex justify-end gap-2 pt-1 border-t border-fh-border">
        <Button variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!title.trim() || !publicKey.trim()}>
          Add deploy key
        </Button>
      </div>
    </form>
  );
}

function DeployKeysSection({ token, handle, repoName, isOwner }: {
  token: string; handle: string; repoName: string; isOwner: boolean;
}) {
  const [keys, setKeys] = useState<DeployKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeployKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!isOwner) { setLoading(false); return; }
    listDeployKeys(token, handle, repoName)
      .then((d) => setKeys(d.keys))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName, isOwner]);

  async function handleCreate(input: { title: string; publicKey: string; readOnly: boolean }) {
    const key = await addDeployKey(token, handle, repoName, input);
    setKeys((prev) => [key, ...prev]);
    setShowNew(false);
    toast("Deploy key added", { tone: "success" });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteDeployKey(token, handle, repoName, pendingDelete.id);
      setKeys((prev) => prev.filter((k) => k.id !== pendingDelete.id));
      toast("Deploy key deleted", { tone: "success" });
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete deploy key", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-4 pb-3 mb-4 border-b border-fh-border">
        <div>
          <h2 className="text-fh-lg font-semibold text-fh-fg">Deploy keys</h2>
          <p className="text-fh-sm text-fh-fg-muted mt-0.5">
            SSH keys that grant access to this single repository — ideal for CI and automation. Read-only unless you allow write.
          </p>
        </div>
        {isOwner && !showNew && <Button variant="primary" onClick={() => setShowNew(true)}>Add deploy key</Button>}
      </div>

      {!isOwner ? (
        <p className="text-fh-sm text-fh-fg-muted rounded-md border border-fh-border bg-fh-surface px-4 py-3">
          Only the repository owner can manage deploy keys.
        </p>
      ) : (
        <>
          {showNew && <DeployKeyForm onSave={handleCreate} onCancel={() => setShowNew(false)} />}

          {loading ? (
            <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton variant="block" width={18} height={18} className="rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          ) : keys.length === 0 && !showNew ? (
            <div className="bg-fh-surface border border-fh-border rounded-md">
              <EmptyState
                icon={<Icon path={KEY} size={28} />}
                title="No deploy keys yet"
                description="Add a deploy key to give a CI system or automation SSH access to this repository."
              />
            </div>
          ) : (
            keys.length > 0 && (
              <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-start gap-3 px-4 py-3">
                    <span className="shrink-0 mt-0.5 text-fh-fg-muted"><Icon path={KEY} size={18} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-fh-sm font-semibold text-fh-fg flex items-center gap-2 flex-wrap">
                        <span className="truncate">{k.title}</span>
                        {k.readOnly ? <Badge tone="neutral">Read-only</Badge> : <Badge tone="accent">Read/write</Badge>}
                      </p>
                      <p className="text-fh-xs font-mono text-fh-fg-muted mt-1 break-all">{k.fingerprint}</p>
                      <p className="text-fh-xs text-fh-fg-subtle mt-1">Added <RelativeTime date={k.createdAt} /></p>
                    </div>
                    <Button variant="danger" size="sm" onClick={() => setPendingDelete(k)}>Delete</Button>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete deploy key"
          message={<>Delete the deploy key <span className="font-semibold">"{pendingDelete.title}"</span>? Anything using it will immediately lose access.</>}
          confirmLabel="Delete deploy key"
          loading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
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

type SectionKey = "general" | "topics" | "collaborators" | "branches" | "labels" | "webhooks" | "deploy-keys" | "danger";

export function RepoSettingsTab({ token, handle, repoName, user }: Props) {
  const [section, setSection] = useState<SectionKey>("general");
  const fullName = `${handle}/${repoName}`;
  // Repos are namespaced under their owner's handle, so the URL handle IS the
  // owner — the owner-gated protection controls key off this.
  const isOwner = user.handle.toLowerCase() === handle.toLowerCase();

  const nav: { key: SectionKey; label: string; icon: string; danger?: boolean }[] = [
    { key: "general", label: "General", icon: GEAR },
    { key: "topics", label: "Topics", icon: BOOKMARK },
    { key: "collaborators", label: "Collaborators", icon: PEOPLE },
    { key: "branches", label: "Branches", icon: BRANCH },
    { key: "labels", label: "Labels", icon: LABEL },
    { key: "webhooks", label: "Webhooks", icon: WEBHOOK },
    { key: "deploy-keys", label: "Deploy keys", icon: KEY },
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
        {section === "branches" && <BranchesSection token={token} handle={handle} repoName={repoName} isOwner={isOwner} />}
        {section === "labels" && <LabelsSection token={token} handle={handle} repoName={repoName} />}
        {section === "webhooks" && <WebhooksSection token={token} handle={handle} repoName={repoName} />}
        {section === "deploy-keys" && <DeployKeysSection token={token} handle={handle} repoName={repoName} isOwner={isOwner} />}
        {section === "danger" && <DangerSection repoName={repoName} fullName={fullName} />}
      </div>
    </div>
  );
}
