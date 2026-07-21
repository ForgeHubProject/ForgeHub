import { useState } from "react";
import { login, register } from "../api";
import { ForgeLogo } from "../components/ForgeLogo";
import { Button, Field, TextInput } from "../ui";
import type { User } from "../types";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = {
  onAuth: (token: string, user: User) => void;
};

type Mode = "login" | "register";

export function LoginPage({ onAuth }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isLogin = mode === "login";
  useDocumentTitle(isLogin ? "Sign in · ForgeHub" : "Sign up · ForgeHub");

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = isLogin
        ? await login(email, password)
        : await register(email, password, handle, displayName || undefined);
      onAuth(res.token, res.user);
    } catch (err) {
      const fallback = isLogin
        ? "Unable to sign in. Please check your details and try again."
        : "Unable to create your account. Please try again.";
      setError(err instanceof Error && err.message ? err.message : fallback);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-fh-canvas flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[22rem]">
        <div className="flex flex-col items-center">
          <span className="text-fh-accent-fg mb-4">
            <ForgeLogo size={40} />
          </span>
          <h1 className="text-fh-xl font-semibold text-fh-fg text-center">
            {isLogin ? "Sign in to ForgeHub" : "Create your account"}
          </h1>
        </div>

        <div className="mt-5 bg-fh-surface border border-fh-border rounded-md p-5">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-fh-danger-fg/30 bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg"
            >
              {error}
            </div>
          )}

          <form onSubmit={submit} className="flex flex-col gap-4">
            {!isLogin && (
              <>
                <Field label="Username" required>
                  {(id) => (
                    <TextInput
                      id={id}
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="octocat"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      autoFocus
                    />
                  )}
                </Field>
                <Field label="Name" hint="Shown on your profile. Optional.">
                  {(id) => (
                    <TextInput
                      id={id}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="The Octocat"
                      autoComplete="name"
                    />
                  )}
                </Field>
              </>
            )}

            <Field label="Email address" required>
              {(id) => (
                <TextInput
                  id={id}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  autoFocus={isLogin}
                />
              )}
            </Field>

            <Field label="Password" required>
              {(id) => (
                <TextInput
                  id={id}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? "Enter your password" : "Create a password"}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  required
                />
              )}
            </Field>

            <Button type="submit" variant="primary" block loading={loading} className="mt-1">
              {isLogin ? "Sign in" : "Create account"}
            </Button>
          </form>
        </div>

        <div className="mt-4 rounded-md border border-fh-border bg-fh-surface px-4 py-3 text-center text-fh-sm text-fh-fg-muted">
          {isLogin ? (
            <>
              New to ForgeHub?{" "}
              <button
                type="button"
                onClick={() => switchMode("register")}
                className="font-medium text-fh-accent-fg hover:underline"
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => switchMode("login")}
                className="font-medium text-fh-accent-fg hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-fh-xs text-fh-fg-subtle">
          <span>© 2026 ForgeHub</span>
          <a href="#" className="hover:text-fh-accent-fg hover:underline">
            Terms
          </a>
          <a href="#" className="hover:text-fh-accent-fg hover:underline">
            Privacy
          </a>
          <a href="#" className="hover:text-fh-accent-fg hover:underline">
            Docs
          </a>
        </footer>
      </div>
    </main>
  );
}
