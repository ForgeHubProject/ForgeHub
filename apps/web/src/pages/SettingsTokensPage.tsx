import { useEffect, useState } from "react";
import { createToken, listTokens, revokeToken } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Header } from "../components/Header";
import type { PersonalAccessToken, User } from "../types";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function isExpired(expiresAt: string | null): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() < Date.now();
}

export function SettingsTokensPage({ token, user, onLogout }: Props) {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("90");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<PersonalAccessToken | null>(null);

  function load() {
    setLoading(true);
    listTokens(token)
      .then((d) => setTokens(d.tokens))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [token]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const days = expiresInDays.trim() ? Number(expiresInDays) : undefined;
      const created = await createToken(token, name.trim(), days);
      setNewToken(created.token);
      setName("");
      setShowCreate(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!pendingRevoke) return;
    await revokeToken(token, pendingRevoke.id);
    setTokens((prev) => prev.filter((t) => t.id !== pendingRevoke.id));
    setPendingRevoke(null);
  }

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[900px] mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gh-text">Personal access tokens</h1>
            <p className="text-sm text-gh-muted mt-0.5">
              Use a token as the password for git-over-HTTPS instead of your account password.
            </p>
          </div>
          <button className="btn-primary text-sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "Generate new token"}
          </button>
        </div>

        {newToken && (
          <div className="card p-4 mb-6 border border-gh-success bg-green-50">
            <p className="text-sm font-semibold text-gh-text mb-2">
              Copy your new token now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-white border border-gh-border rounded px-3 py-2 font-mono break-all">
                {newToken}
              </code>
              <button
                className="btn-default text-sm"
                onClick={() => navigator.clipboard.writeText(newToken)}
              >
                Copy
              </button>
            </div>
            <button
              className="text-xs text-gh-muted mt-2 hover:text-gh-text underline"
              onClick={() => setNewToken(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {showCreate && (
          <form onSubmit={handleCreate} className="card p-4 mb-6 space-y-3">
            {error && <p className="text-sm text-gh-danger">{error}</p>}
            <div>
              <label className="block text-sm font-medium text-gh-text mb-1">Name</label>
              <input
                className="input w-full"
                placeholder="e.g. laptop, CI pipeline"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gh-text mb-1">Expiration (days)</label>
              <input
                className="input w-full"
                type="number"
                min={1}
                placeholder="Leave blank for no expiration"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary text-sm" disabled={creating || !name.trim()}>
              {creating ? "Generating…" : "Generate token"}
            </button>
          </form>
        )}

        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="card p-4 animate-pulse h-16" />
            ))}
          </div>
        ) : tokens.length === 0 ? (
          <div className="card py-16 text-center">
            <p className="text-sm text-gh-muted">No personal access tokens yet.</p>
          </div>
        ) : (
          <div className="card divide-y divide-gh-border overflow-hidden">
            {tokens.map((t) => {
              const expired = isExpired(t.expiresAt);
              return (
                <div key={t.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-gh-text">{t.name}</p>
                    <p className="text-xs text-gh-muted mt-0.5 font-mono">{t.prefix}…</p>
                    <p className="text-xs text-gh-muted mt-1">
                      Created {formatDate(t.createdAt)} · Last used {formatDate(t.lastUsedAt)}
                      {t.expiresAt && (
                        <span className={expired ? "text-gh-danger" : ""}>
                          {" "}· {expired ? "Expired" : "Expires"} {formatDate(t.expiresAt)}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    className="btn-default text-sm text-gh-danger"
                    onClick={() => setPendingRevoke(t)}
                  >
                    Revoke
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke token"
          message={`Revoke "${pendingRevoke.name}"? Anything using this token will immediately lose access.`}
          confirmLabel="Revoke"
          onConfirm={() => void handleRevoke()}
          onCancel={() => setPendingRevoke(null)}
        />
      )}
    </div>
  );
}
