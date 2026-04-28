import { useEffect, useState } from "react";
import { createRepo, getMyRepos } from "../api";
import type { Repo, User } from "../types";

type Props = {
  token: string;
  user: User;
  onSelectRepo: (repo: Repo) => void;
  onLogout: () => void;
};

type CreateForm = {
  name: string;
  description: string;
  visibility: "public" | "private";
};

export function RepoListPage({ token, user, onSelectRepo, onLogout }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>({ name: "", description: "", visibility: "private" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    getMyRepos(token)
      .then((r) => setRepos(r.repos))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token]);

  function openCreate() {
    setForm({ name: "", description: "", visibility: "private" });
    setCreateError(null);
    setShowCreate(true);
  }

  function closeCreate() {
    setShowCreate(false);
    setCreateError(null);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const repo = await createRepo(token, form.name, form.description || undefined, form.visibility);
      setRepos((prev) => [repo, ...prev]);
      closeCreate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logo}>ForgeHub</span>
        <div style={styles.userRow}>
          <span style={styles.handle}>@{user.handle}</span>
          <button onClick={onLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.headingRow}>
          <h2 style={styles.heading}>Your repositories</h2>
          <button onClick={openCreate} style={styles.newBtn}>+ New repository</button>
        </div>

        {loading && <p style={styles.muted}>Loading...</p>}
        {error && <p style={styles.error}>{error}</p>}
        {!loading && repos.length === 0 && (
          <p style={styles.muted}>No repositories yet. Create your first one.</p>
        )}

        <div style={styles.list}>
          {repos.map((repo) => (
            <button
              key={repo.id}
              style={styles.repoCard}
              onClick={() => onSelectRepo(repo)}
            >
              <div style={styles.repoName}>{repo.fullName ?? repo.name}</div>
              {repo.description && <div style={styles.repoDesc}>{repo.description}</div>}
              <div style={styles.repoBadge}>
                {repo.visibility === "public" ? "Public" : "Private"}
              </div>
            </button>
          ))}
        </div>
      </main>

      {/* Create repo modal */}
      {showCreate && (
        <div style={styles.backdrop} onClick={closeCreate}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>New repository</h3>
              <button onClick={closeCreate} style={styles.closeBtn}>✕</button>
            </div>

            <form onSubmit={submitCreate} style={styles.modalForm}>
              <label style={styles.label}>
                Name <span style={styles.required}>*</span>
              </label>
              <input
                style={styles.input}
                placeholder="my-project"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
                required
              />
              <p style={styles.hint}>Lowercase letters, numbers, hyphens and dots only.</p>

              <label style={styles.label}>Description</label>
              <textarea
                style={styles.textarea}
                placeholder="Optional short description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
              />

              <label style={styles.label}>Visibility</label>
              <div style={styles.visibilityRow}>
                {(["private", "public"] as const).map((v) => (
                  <label key={v} style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="visibility"
                      value={v}
                      checked={form.visibility === v}
                      onChange={() => setForm((f) => ({ ...f, visibility: v }))}
                    />
                    <div>
                      <span style={styles.radioTitle}>{v === "private" ? "Private" : "Public"}</span>
                      <span style={styles.radioSub}>
                        {v === "private"
                          ? "Only you and collaborators can see it"
                          : "Anyone can see this repository"}
                      </span>
                    </div>
                  </label>
                ))}
              </div>

              {createError && <p style={styles.createError}>{createError}</p>}

              <div style={styles.modalActions}>
                <button type="button" onClick={closeCreate} style={styles.cancelBtn}>
                  Cancel
                </button>
                <button type="submit" style={styles.createBtn} disabled={creating || !form.name.trim()}>
                  {creating ? "Creating..." : "Create repository"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", backgroundColor: "#f9fafb" },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 24px", backgroundColor: "#fff",
    borderBottom: "1px solid #e5e7eb",
  },
  logo: { fontSize: 18, fontWeight: 700, color: "#111827" },
  userRow: { display: "flex", alignItems: "center", gap: 12 },
  handle: { fontSize: 13, color: "#6b7280" },
  logoutBtn: {
    fontSize: 13, color: "#6b7280", background: "none", border: "1px solid #e5e7eb",
    borderRadius: 6, padding: "4px 10px", cursor: "pointer",
  },
  main: { maxWidth: 720, margin: "0 auto", padding: "32px 24px" },
  headingRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  heading: { fontSize: 20, fontWeight: 600, color: "#111827", margin: 0 },
  newBtn: {
    fontSize: 13, fontWeight: 600, color: "#fff", backgroundColor: "#111827",
    border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer",
  },
  muted: { color: "#6b7280", fontSize: 14 },
  error: { color: "#ef4444", fontSize: 14 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  repoCard: {
    textAlign: "left", padding: "16px 20px", backgroundColor: "#fff",
    border: "1px solid #e5e7eb", borderRadius: 8, cursor: "pointer", width: "100%",
  },
  repoName: { fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: 4 },
  repoDesc: { fontSize: 13, color: "#6b7280", marginBottom: 8 },
  repoBadge: {
    display: "inline-block", fontSize: 11, color: "#6b7280",
    border: "1px solid #e5e7eb", borderRadius: 10, padding: "1px 8px",
  },
  // Modal
  backdrop: {
    position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
  },
  modal: {
    backgroundColor: "#fff", borderRadius: 12, width: 480,
    boxShadow: "0 20px 60px rgba(0,0,0,0.15)", overflow: "hidden",
  },
  modalHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "18px 24px", borderBottom: "1px solid #f3f4f6",
  },
  modalTitle: { fontSize: 16, fontWeight: 600, color: "#111827", margin: 0 },
  closeBtn: {
    fontSize: 16, color: "#9ca3af", background: "none",
    border: "none", cursor: "pointer", lineHeight: 1,
  },
  modalForm: { padding: "20px 24px", display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: "#374151", marginTop: 8 },
  required: { color: "#ef4444" },
  input: {
    padding: "8px 12px", fontSize: 14, border: "1px solid #d1d5db",
    borderRadius: 6, outline: "none",
  },
  hint: { fontSize: 12, color: "#9ca3af", margin: 0 },
  textarea: {
    padding: "8px 12px", fontSize: 14, border: "1px solid #d1d5db",
    borderRadius: 6, outline: "none", resize: "vertical", fontFamily: "inherit",
  },
  visibilityRow: { display: "flex", flexDirection: "column", gap: 8, marginTop: 4 },
  radioLabel: {
    display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
    border: "1px solid #e5e7eb", borderRadius: 8, cursor: "pointer",
  },
  radioTitle: { display: "block", fontSize: 13, fontWeight: 500, color: "#111827" },
  radioSub: { display: "block", fontSize: 12, color: "#6b7280", marginTop: 2 },
  createError: { fontSize: 13, color: "#ef4444", margin: 0 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  cancelBtn: {
    padding: "8px 16px", fontSize: 13, color: "#6b7280", backgroundColor: "transparent",
    border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer",
  },
  createBtn: {
    padding: "8px 16px", fontSize: 13, fontWeight: 600, color: "#fff",
    backgroundColor: "#111827", border: "none", borderRadius: 6, cursor: "pointer",
  },
};
