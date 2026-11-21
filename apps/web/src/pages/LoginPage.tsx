import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError, getServerInfo, login, loginTwoFactor, register } from "../api";
import { ForgeLogo } from "../components/ForgeLogo";
import { Button, Field, TextInput } from "../ui";
import type { User } from "../types";
import { useDocumentTitle } from "./useDocumentTitle";

/** Where the docs (the README) and the code live; the site footer's Source link goes here too. */
const SOURCE_URL = "https://github.com/ForgeHubProject/ForgeHub";

type Props = {
  onAuth: (token: string, user: User) => void;
};

type Mode = "login" | "register";

export function LoginPage({ onAuth }: Props) {
  // Signed-out "Sign up" links open the form in register mode.
  const [mode, setMode] = useState<Mode>(() => (new URLSearchParams(window.location.search).get("mode") === "register" ? "register" : "login"));
  // The landing page's "Sign up for ForgeHub" hands over the email typed there.
  const handedEmail = (useLocation().state as { email?: unknown } | null)?.email;
  const [email, setEmail] = useState(() => (typeof handedEmail === "string" ? handedEmail : ""));
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Two-factor (#258): the password was right; a code from the app finishes signing in.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Optimistic: assume sign-up is open until /server/info says otherwise, so a
  // failed fetch never hides the form on an open instance (the API still enforces).
  const [registrationClosed, setRegistrationClosed] = useState(false);

  useEffect(() => {
    getServerInfo()
      .then((info) => {
        if (info.registration === "closed") {
          setRegistrationClosed(true);
          setMode("login");
        }
      })
      .catch(() => {});
  }, []);

  const isLogin = mode === "login";
  useDocumentTitle(challenge ? "Two-factor authentication · ForgeHub" : isLogin ? "Sign in · ForgeHub" : "Sign up · ForgeHub");

  function switchMode(next: Mode) {
    // A handle typed at sign-in would be stranded in what becomes a
    // type="email" field, where native validation blocks submit — migrate it
    // to the Username field it was meant for.
    if (next === "register" && email && !email.includes("@")) {
      if (!handle) setHandle(email.trim());
      setEmail("");
    }
    setMode(next);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Trimmed because paste and mobile keyboards routinely append a space,
      // and neither identifier grammar accepts surrounding whitespace. The
      // password is sent verbatim — a space there may be real.
      const identifier = email.trim();
      const res = isLogin
        ? await login(identifier, password)
        : await register(identifier, password, handle.trim(), displayName || undefined);
      if ("challenge" in res) {
        setChallenge(res.challenge);
        setPassword("");
        return;
      }
      onAuth(res.token, res.user);
    } catch (err) {
      if (isLogin && err instanceof ApiError && err.status === 400 && err.fieldErrors?.email) {
        // The identifier failed validation — the request never reached the
        // password check, so the credentials message would point the user at
        // the wrong field. (Only when the server blames the email field: a
        // 400 about the password must not be pinned on the identifier.)
        setError("Enter a valid username or email address.");
        return;
      }
      const fallback = isLogin
        ? "Unable to sign in. Please check your details and try again."
        : "Unable to create your account. Please try again.";
      setError(err instanceof Error && err.message ? err.message : fallback);
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setLoading(true);
    try {
      const res = await loginTwoFactor(challenge, code.trim());
      onAuth(res.token, res.user);
    } catch (err) {
      setCode("");
      setError(err instanceof Error && err.message ? err.message : "Unable to verify the code. Please try again.");
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
            {challenge ? "Two-factor authentication" : isLogin ? "Sign in to ForgeHub" : "Create your account"}
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

          {challenge ? (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              <Field label="Authentication code" hint="Open your authenticator app, or enter one of your recovery codes." required>
                {(id) => (
                  <TextInput
                    id={id}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="XXXXXX"
                    autoComplete="one-time-code"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={64}
                    required
                    autoFocus
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" block loading={loading}>
                Verify
              </Button>
              <Button variant="invisible" block onClick={() => { setChallenge(null); setCode(""); setError(null); }}>
                Back to sign in
              </Button>
            </form>
          ) : (
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

              {/* At sign-in this accepts a handle too (GitHub's "Username or email
                  address"), so it must be type="text" there — type="email" makes
                  the browser reject a handle before the request is ever sent. */}
              <Field label={isLogin ? "Username or email address" : "Email address"} required>
                {(id) => (
                  <TextInput
                    id={id}
                    type={isLogin ? "text" : "email"}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={isLogin ? "octocat or you@example.com" : "you@example.com"}
                    autoComplete={isLogin ? "username" : "email"}
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
          )}
        </div>

        <div className="mt-4 rounded-md border border-fh-border bg-fh-surface px-4 py-3 text-center text-fh-sm text-fh-fg-muted">
          {registrationClosed ? (
            <>Sign-up is closed on this server. Ask an administrator for an account.</>
          ) : isLogin ? (
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

        {/* GitHub's sign-in footer also has Terms and Privacy: they come back when ForgeHub has those pages. */}
        <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-fh-xs text-fh-fg-subtle">
          <span>© {new Date().getFullYear()} ForgeHub</span>
          <a href={`${SOURCE_URL}#readme`} className="hover:text-fh-accent-fg hover:underline">
            Docs
          </a>
          <a href={SOURCE_URL} className="hover:text-fh-accent-fg hover:underline">
            Source
          </a>
        </footer>
      </div>
    </main>
  );
}
