import { useEffect, useState } from "react";
import { getMyRepos } from "../api";
import type { Repo, User } from "../types";

type Props = {
  token: string;
  user: User;
  onSelectRepo: (repo: Repo) => void;
  onLogout: () => void;
};

export function RepoListPage({ token, user, onSelectRepo, onLogout }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyRepos(token)
      .then((r) => setRepos(r.repos))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token]);

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
        <h2 style={styles.heading}>Your repositories</h2>
        {loading && <p style={styles.muted}>Loading...</p>}
        {error && <p style={styles.error}>{error}</p>}
        {!loading && repos.length === 0 && (
          <p style={styles.muted}>No repositories yet. Create one via the API.</p>
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
  heading: { fontSize: 20, fontWeight: 600, color: "#111827", marginBottom: 20 },
  muted: { color: "#6b7280", fontSize: 14 },
  error: { color: "#ef4444", fontSize: 14 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  repoCard: {
    textAlign: "left", padding: "16px 20px", backgroundColor: "#fff",
    border: "1px solid #e5e7eb", borderRadius: 8, cursor: "pointer",
    width: "100%",
  },
  repoName: { fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: 4 },
  repoDesc: { fontSize: 13, color: "#6b7280", marginBottom: 8 },
  repoBadge: {
    display: "inline-block", fontSize: 11, color: "#6b7280",
    border: "1px solid #e5e7eb", borderRadius: 10, padding: "1px 8px",
  },
};
