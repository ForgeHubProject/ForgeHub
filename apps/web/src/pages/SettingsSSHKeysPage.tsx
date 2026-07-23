import { useEffect, useState } from "react";
import { addSSHKey, deleteSSHKey, listSSHKeys } from "../api";
import { Header } from "../components/Header";
import type { SSHKey, User } from "../types";
import {
  Button, ConfirmDialog, Dialog, EmptyState, Field, PageHeading,
  RelativeTime, Skeleton, TextInput, Textarea, useToast,
} from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

// ── local Octicon-style marks ─────────────────────────────────────────────────

function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const KEY = "M10.5 0a5.499 5.499 0 00-5.243 7.148L.436 11.97a1.489 1.489 0 00-.436 1.053v1.487C0 15.328.672 16 1.5 16h1.487c.395 0 .774-.157 1.054-.436l.31-.311a.75.75 0 00.22-.53v-.807h.807a.75.75 0 00.53-.22l.716-.716a.75.75 0 00.22-.53v-.807h.462l4.822-4.821A5.499 5.499 0 0010.5 0zm1.5 4.75a1 1 0 11-2 0 1 1 0 012 0z";

// ── add-key dialog ────────────────────────────────────────────────────────────

function NewKeyDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string, publicKey: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setTitle(""); setPublicKey(""); setError(null); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !publicKey.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(title.trim(), publicKey.trim());
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add SSH key");
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add a new SSH key"
      description="Paste the contents of your public key file (e.g. ~/.ssh/id_ed25519.pub)."
      footer={
        <>
          <Button variant="default" onClick={() => { reset(); onClose(); }} disabled={creating}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-ssh-key-form" loading={creating} disabled={!title.trim() || !publicKey.trim()}>
            Add SSH key
          </Button>
        </>
      }
    >
      <form id="new-ssh-key-form" onSubmit={submit} className="space-y-4">
        <Field label="Title" required hint="A memorable name, so you know which machine this key is for.">
          {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. laptop, work desktop" autoFocus />}
        </Field>
        <Field label="Key" required hint="Begins with 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-…'.">
          {(id) => (
            <Textarea
              id={id}
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... you@host"
              rows={5}
              className="font-mono text-fh-xs"
            />
          )}
        </Field>
        {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      </form>
    </Dialog>
  );
}

export function SettingsSSHKeysPage({ token, user, onLogout }: Props) {
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SSHKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  function load() {
    setLoading(true);
    listSSHKeys(token)
      .then((d) => setKeys(d.keys))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  async function handleCreate(title: string, publicKey: string) {
    const created = await addSSHKey(token, title, publicKey);
    setKeys((prev) => [created, ...prev]);
    setShowCreate(false);
    toast(`Added "${created.title}"`, { tone: "success" });
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteSSHKey(token, pendingDelete.id);
      setKeys((prev) => prev.filter((k) => k.id !== pendingDelete.id));
      toast(`Deleted "${pendingDelete.title}"`, { tone: "success" });
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete SSH key", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-screen bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[900px] mx-auto px-4 py-8">
        <PageHeading
          title="SSH keys"
          icon={<Icon path={KEY} size={20} />}
          description="SSH keys let you connect to ForgeHub over git without a password. Add your public key here."
          actions={<Button variant="primary" onClick={() => setShowCreate(true)}>New SSH key</Button>}
          divider
        />

        {loading ? (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center justify-between px-4 py-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        ) : keys.length === 0 ? (
          <div className="bg-fh-surface border border-fh-border rounded-md">
            <EmptyState
              icon={<Icon path={KEY} size={32} />}
              title="No SSH keys"
              description="Add a public key to clone and push over SSH from your machines."
              actions={<Button variant="primary" onClick={() => setShowCreate(true)}>New SSH key</Button>}
            />
          </div>
        ) : (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {keys.map((k) => (
              <div key={k.id} className="flex items-start justify-between gap-4 px-4 py-4">
                <div className="min-w-0 flex items-start gap-3">
                  <span className="text-fh-fg-muted mt-0.5 shrink-0"><Icon path={KEY} size={18} /></span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg truncate">{k.title}</span>
                    </div>
                    <p className="text-fh-xs font-mono text-fh-fg-muted mt-1 break-all">{k.fingerprint}</p>
                    <p className="text-fh-xs text-fh-fg-subtle mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span>Added <RelativeTime date={k.createdAt} /></span>
                      <span aria-hidden>·</span>
                      <span>{k.lastUsedAt ? <>Last used <RelativeTime date={k.lastUsedAt} /></> : "Never used"}</span>
                    </p>
                  </div>
                </div>
                <Button variant="danger" size="sm" onClick={() => setPendingDelete(k)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <NewKeyDialog open={showCreate} onClose={() => setShowCreate(false)} onCreate={handleCreate} />

      {pendingDelete && (
        <ConfirmDialog
          title="Delete SSH key"
          message={<>Delete <span className="font-semibold">"{pendingDelete.title}"</span>? Anything using this key will immediately lose access.</>}
          confirmLabel="Delete SSH key"
          loading={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
