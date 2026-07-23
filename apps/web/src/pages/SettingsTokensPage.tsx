import { useEffect, useState } from "react";
import { createToken, listTokens, revokeToken } from "../api";
import { Header } from "../components/Header";
import type { PatScope, PersonalAccessToken, User } from "../types";
import {
  Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, PageHeading,
  RelativeTime, Select, Skeleton, TextInput, useToast,
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
const COPY = "M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25zM6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5C5 .784 5.784 0 6.75 0zm0 1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z";
const ALERT = "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575zm1.763.707a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368zm.53 3.996v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 011.5 0zM9 11a1 1 0 11-2 0 1 1 0 012 0z";

function isExpired(expiresAt: string | null): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() < Date.now();
}

// ── scopes ────────────────────────────────────────────────────────────────────

const SCOPE_OPTIONS: { value: PatScope; label: string; hint: string }[] = [
  { value: "repo:read", label: "repo:read", hint: "Read repositories and clone/pull over HTTPS" },
  { value: "repo:write", label: "repo:write", hint: "Push commits and write repository data" },
  { value: "admin", label: "admin", hint: "Manage settings, webhooks, and tokens" },
];

const SCOPE_TONE: Record<PatScope, "neutral" | "accent" | "danger"> = {
  "repo:read": "neutral",
  "repo:write": "accent",
  admin: "danger",
};

// ── new-token dialog ──────────────────────────────────────────────────────────

function NewTokenDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, expiresInDays: number | undefined, scopes: PatScope[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("90");
  const [scopes, setScopes] = useState<PatScope[]>(["repo:read", "repo:write", "admin"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setName(""); setExpires("90"); setScopes(["repo:read", "repo:write", "admin"]); setError(null); }

  function toggleScope(s: PatScope) {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim(), expires ? Number(expires) : undefined, scopes);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Generate a personal access token"
      description="Use it as your password for git over HTTPS."
      footer={
        <>
          <Button variant="default" onClick={() => { reset(); onClose(); }} disabled={creating}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-token-form" loading={creating} disabled={!name.trim() || scopes.length === 0}>
            Generate token
          </Button>
        </>
      }
    >
      <form id="new-token-form" onSubmit={submit} className="space-y-4">
        <Field label="Token name" required hint="A memorable name, so you know where it's used.">
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop, CI pipeline" autoFocus />}
        </Field>
        <Field label="Expiration">
          {(id) => (
            <Select id={id} value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="">No expiration</option>
            </Select>
          )}
        </Field>
        <div>
          <p className="text-fh-sm font-semibold text-fh-fg mb-1.5">Scopes</p>
          <p className="text-fh-xs text-fh-fg-muted mb-2">Grant only what this token needs. A push requires <code className="font-mono">repo:write</code>; managing settings, webhooks, and tokens requires <code className="font-mono">admin</code>.</p>
          <div className="space-y-1.5">
            {SCOPE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-start gap-2 rounded-md border border-fh-border px-3 py-2 cursor-pointer hover:bg-fh-surface-muted">
                <input type="checkbox" className="mt-0.5 accent-fh-accent-emphasis" checked={scopes.includes(opt.value)} onChange={() => toggleScope(opt.value)} />
                <span className="min-w-0">
                  <span className="block text-fh-sm font-mono font-medium text-fh-fg">{opt.label}</span>
                  <span className="block text-fh-xs text-fh-fg-muted">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      </form>
    </Dialog>
  );
}

// ── one-time secret reveal ────────────────────────────────────────────────────

function SecretReveal({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast("Token copied to clipboard", { tone: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select and copy manually.", { tone: "danger" });
    }
  }

  return (
    <div className="rounded-md border border-fh-success-emphasis/40 bg-fh-success-muted/40 p-4 mb-6">
      <div className="flex items-start gap-2 mb-3">
        <span className="text-fh-success-fg mt-0.5"><Icon path={ALERT} size={16} /></span>
        <div>
          <p className="text-fh-sm font-semibold text-fh-fg">Make sure to copy your token now.</p>
          <p className="text-fh-sm text-fh-fg-muted">For security, it won't be shown again once you leave this page.</p>
        </div>
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 text-fh-sm bg-fh-surface-inset border border-fh-border rounded-md px-3 py-2 font-mono text-fh-fg break-all">
          {secret}
        </code>
        <Button variant="default" leadingIcon={<Icon path={COPY} size={14} />} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <button
        onClick={onDismiss}
        className="mt-3 text-fh-xs text-fh-fg-muted hover:text-fh-fg underline cursor-pointer bg-transparent border-none p-0"
      >
        I've copied it — dismiss
      </button>
    </div>
  );
}

export function SettingsTokensPage({ token, user, onLogout }: Props) {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<PersonalAccessToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const { toast } = useToast();

  function load() {
    setLoading(true);
    listTokens(token)
      .then((d) => setTokens(d.tokens))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  async function handleCreate(name: string, expiresInDays: number | undefined, scopes: PatScope[]) {
    const created = await createToken(token, name, expiresInDays, scopes);
    setNewToken(created.token);
    setShowCreate(false);
    load();
  }

  async function handleRevoke() {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      await revokeToken(token, pendingRevoke.id);
      setTokens((prev) => prev.filter((t) => t.id !== pendingRevoke.id));
      toast(`Revoked "${pendingRevoke.name}"`, { tone: "success" });
      setPendingRevoke(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to revoke token", { tone: "danger" });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="min-h-screen bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[900px] mx-auto px-4 py-8">
        <PageHeading
          title="Personal access tokens"
          icon={<Icon path={KEY} size={20} />}
          description="Tokens work like a password for git over HTTPS and the API. Treat them as secrets."
          actions={<Button variant="primary" onClick={() => setShowCreate(true)}>Generate new token</Button>}
          divider
        />

        {newToken && <SecretReveal secret={newToken} onDismiss={() => setNewToken(null)} />}

        {loading ? (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between px-4 py-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        ) : tokens.length === 0 ? (
          <div className="bg-fh-surface border border-fh-border rounded-md">
            <EmptyState
              icon={<Icon path={KEY} size={32} />}
              title="No personal access tokens"
              description="Generate a token to authenticate git pushes and API requests from your machines and CI."
              actions={<Button variant="primary" onClick={() => setShowCreate(true)}>Generate new token</Button>}
            />
          </div>
        ) : (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {tokens.map((t) => {
              const expired = isExpired(t.expiresAt);
              return (
                <div key={t.id} className="flex items-center justify-between gap-4 px-4 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg truncate">{t.name}</span>
                      <code className="text-fh-xs font-mono text-fh-fg-muted bg-fh-surface-muted rounded px-1.5 py-0.5">{t.prefix}…</code>
                      {expired
                        ? <Badge tone="danger">Expired</Badge>
                        : <Badge tone="success">Active</Badge>}
                      {(t.scopes ?? []).map((s) => (
                        <Badge key={s} tone={SCOPE_TONE[s]}><span className="font-mono">{s}</span></Badge>
                      ))}
                    </div>
                    <p className="text-fh-xs text-fh-fg-subtle mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span>Created <RelativeTime date={t.createdAt} /></span>
                      <span aria-hidden>·</span>
                      <span>{t.lastUsedAt ? <>Last used <RelativeTime date={t.lastUsedAt} /></> : "Never used"}</span>
                      {t.expiresAt && (
                        <>
                          <span aria-hidden>·</span>
                          <span className={expired ? "text-fh-danger-fg" : undefined}>
                            {expired ? "Expired " : "Expires "}<RelativeTime date={t.expiresAt} />
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => setPendingRevoke(t)}>Revoke</Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <NewTokenDialog open={showCreate} onClose={() => setShowCreate(false)} onCreate={handleCreate} />

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke token"
          message={<>Revoke <span className="font-semibold">"{pendingRevoke.name}"</span>? Anything using this token will immediately lose access.</>}
          confirmLabel="Revoke token"
          loading={revoking}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setPendingRevoke(null)}
        />
      )}
    </div>
  );
}
