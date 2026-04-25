import { useState } from "react";
import { login, register } from "../api";
import type { User } from "../types";

type Props = {
  onAuth: (token: string, user: User) => void;
};

export function LoginPage({ onAuth }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res =
        mode === "login"
          ? await login(email, password)
          : await register(email, password, handle, displayName || undefined);
      onAuth(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>ForgeHub</h1>
        <p style={styles.sub}>Hardware collaboration platform</p>

        <div style={styles.tabs}>
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{ ...styles.tab, ...(mode === m ? styles.tabActive : {}) }}
            >
              {m === "login" ? "Sign in" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {mode === "register" && (
            <>
              <input
                style={styles.input}
                placeholder="Username (handle)"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                required
              />
              <input
                style={styles.input}
                placeholder="Display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </>
          )}
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={loading}>
            {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f9fafb",
  },
  card: {
    backgroundColor: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "40px 36px",
    width: 360,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },
  logo: { fontSize: 24, fontWeight: 700, color: "#111827", margin: 0 },
  sub: { fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 24 },
  tabs: { display: "flex", gap: 8, marginBottom: 20 },
  tab: {
    flex: 1, padding: "8px 0", fontSize: 13, fontWeight: 500,
    border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer",
    backgroundColor: "transparent", color: "#6b7280",
  },
  tabActive: {
    backgroundColor: "#111827", color: "#fff", borderColor: "#111827",
  },
  form: { display: "flex", flexDirection: "column", gap: 10 },
  input: {
    padding: "9px 12px", fontSize: 14, border: "1px solid #d1d5db",
    borderRadius: 6, outline: "none",
  },
  error: { fontSize: 13, color: "#ef4444", margin: 0 },
  btn: {
    padding: "10px 0", fontSize: 14, fontWeight: 600,
    backgroundColor: "#111827", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer", marginTop: 4,
  },
};
