import { useState } from "react";
import { login, register } from "../api";
import { ForgeLogo } from "../components/ForgeLogo";
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
    <div className="min-h-screen bg-gh-bg flex flex-col items-center justify-center px-4">
      {/* Logo mark */}
      <div className="mb-5 text-gh-accent">
        <ForgeLogo size={48} />
      </div>

      <div className="w-full max-w-sm">
        <h1 className="text-center text-gh-xl font-semibold text-gh-text mb-4">
          {mode === "login" ? "Sign in to ForgeHub" : "Create your account"}
        </h1>

        <div className="card p-6">
          <form onSubmit={submit} className="flex flex-col gap-4">
            {mode === "register" && (
              <>
                <div className="form-group">
                  <label className="label" htmlFor="handle">Username</label>
                  <input
                    id="handle"
                    className="input"
                    placeholder="octocat"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="label" htmlFor="displayName">Name <span className="text-gh-muted font-normal">(optional)</span></label>
                  <input
                    id="displayName"
                    className="input"
                    placeholder="The Octocat"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label className="label" htmlFor="email">Email address</label>
              <input
                id="email"
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus={mode === "login"}
              />
            </div>

            <div className="form-group">
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                placeholder={mode === "login" ? "Enter your password" : "Create a password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <p className="text-gh-danger text-gh-sm bg-gh-danger-muted border border-gh-danger border-opacity-20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <button className="btn-primary w-full py-2 text-gh-base" type="submit" disabled={loading}>
              {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>

        {/* Toggle mode */}
        <div className="card mt-4 p-4 text-center text-gh-sm text-gh-muted">
          {mode === "login" ? (
            <>
              New to ForgeHub?{" "}
              <button
                className="text-gh-accent hover:underline font-medium bg-transparent border-none cursor-pointer p-0"
                onClick={() => { setMode("register"); setError(null); }}
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                className="text-gh-accent hover:underline font-medium bg-transparent border-none cursor-pointer p-0"
                onClick={() => { setMode("login"); setError(null); }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>

      <footer className="mt-8 text-gh-xs text-gh-muted">
        © 2025 ForgeHub
      </footer>
    </div>
  );
}
