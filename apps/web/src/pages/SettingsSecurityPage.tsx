import { useEffect, useState } from "react";
import {
  changePassword, disableTwoFactor, enableTwoFactor, getTwoFactor, regenerateRecoveryCodes, setupTwoFactor,
} from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { User } from "../types";
import { Badge, Button, Dialog, Field, Skeleton, TextInput, cx, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = { token: string; user: User; onLogout: () => void };

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Settings → Password and authentication (#258): change your password, and
 * two-factor authentication with an authenticator app and recovery codes.
 */
export function SettingsSecurityPage({ token, user, onLogout }: Props) {
  useDocumentTitle("Password and authentication · Settings · ForgeHub");
  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <Section title="Change password" first />
      <ChangePassword token={token} />

      <Section title="Two-factor authentication" />
      <TwoFactor token={token} />
    </SettingsLayout>
  );
}

function Section({ title, first }: { title: string; first?: boolean }) {
  return <h2 className={cx("mb-4 border-b border-fh-border pb-2 text-fh-xl font-semibold text-fh-fg", !first && "mt-10")}>{title}</h2>;
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{children}</p>;
}

function ChangePassword({ token }: { token: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError("The new passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await changePassword(token, current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Your other sessions were signed out.", { tone: "success" });
    } catch (err) {
      setError(errorText(err, "Couldn't change your password"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-[440px] flex-col gap-3" onSubmit={submit}>
      <Field label="Old password" htmlFor="password-current">
        {(id) => <TextInput id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />}
      </Field>
      <Field label="New password" htmlFor="password-new" hint="8 to 128 characters.">
        {(id) => <TextInput id={id} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required />}
      </Field>
      <Field label="Confirm new password" htmlFor="password-confirm">
        {(id) => <TextInput id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />}
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <Button type="submit" variant="default" loading={busy}>Update password</Button>
      </div>
    </form>
  );
}

function TwoFactor({ token }: { token: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState<"regenerate" | "disable" | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const load = () => getTwoFactor(token).then(setStatus).catch(() => setStatus({ enabled: false, recoveryCodesLeft: 0 }));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function start() {
    setBusy(true);
    try {
      setSetup(await setupTwoFactor(token));
    } catch (err) {
      toast(errorText(err, "Couldn't start the setup"), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithPassword(password: string) {
    if (asking === "regenerate") {
      setCodes((await regenerateRecoveryCodes(token, password)).recoveryCodes);
    } else {
      await disableTwoFactor(token, password);
      toast("Two-factor authentication is off", { tone: "success" });
    }
    setAsking(null);
    await load();
  }

  if (!status) return <Skeleton height={64} />;
  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  if (setup) {
    return (
      <EnableForm
        token={token}
        setup={setup}
        onCancel={() => setSetup(null)}
        onEnabled={(c) => {
          setSetup(null);
          setCodes(c);
          void load();
        }}
      />
    );
  }

  return (
    <div>
      {status.enabled ? (
        <>
          <p className="mb-3 flex flex-wrap items-center gap-2 text-fh-sm text-fh-fg">
            <Badge tone="success">Enabled</Badge>
            Signing in asks for a code from your authenticator app. Git over HTTPS takes a personal access token instead of your password.
          </p>
          <p className="mb-3 text-fh-sm text-fh-fg-muted">
            {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={() => setAsking("regenerate")}>Regenerate recovery codes</Button>
            <Button variant="danger" onClick={() => setAsking("disable")}>Disable two-factor authentication</Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-fh-sm text-fh-fg-muted">
            Protect your account with a second step at sign-in: a code from an authenticator app on your phone.
          </p>
          <Button variant="primary" loading={busy} onClick={() => void start()}>Enable two-factor authentication</Button>
        </>
      )}
      {asking && (
        <PasswordDialog
          title={asking === "regenerate" ? "Regenerate recovery codes" : "Disable two-factor authentication"}
          message={asking === "regenerate" ? "Your current recovery codes stop working." : "Signing in will only need your password."}
          confirmLabel={asking === "regenerate" ? "Regenerate" : "Disable"}
          danger={asking === "disable"}
          onConfirm={confirmWithPassword}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}

function EnableForm({ token, setup, onCancel, onEnabled }: {
  token: string; setup: { secret: string; uri: string }; onCancel: () => void; onEnabled: (codes: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onEnabled((await enableTwoFactor(token, password, code.trim())).recoveryCodes);
    } catch (err) {
      setError(errorText(err, "Couldn't enable two-factor authentication"));
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-[520px] flex-col gap-3" onSubmit={submit}>
      <p className="text-fh-sm text-fh-fg">
        1. Add ForgeHub to your authenticator app: <a href={setup.uri} className="text-fh-accent-fg">open this link on your phone</a>,
        or enter this setup key.
      </p>
      <code className="break-all rounded-md border border-fh-border bg-fh-surface-muted px-3 py-2 font-mono text-fh-sm text-fh-fg" aria-label="Setup key">
        {setup.secret.match(/.{1,4}/g)?.join(" ")}
      </code>
      <p className="text-fh-sm text-fh-fg">2. Enter the 6-digit code the app shows, and your password.</p>
      <Field label="Code from the app" htmlFor="totp-code">
        {(id) => (
          <TextInput id={id} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" required />
        )}
      </Field>
      <Field label="Your password" htmlFor="totp-password">
        {(id) => <TextInput id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={busy}>Enable</Button>
        <Button variant="invisible" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function download() {
    const url = URL.createObjectURL(new Blob([codes.join("\n") + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "forgehub-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-[520px]">
      <p className="mb-3 rounded-md border border-fh-warning-emphasis bg-fh-warning-muted px-3 py-2 text-fh-sm text-fh-fg">
        Save your recovery codes somewhere safe. If you lose your phone, each one signs you in once. They won't be shown again.
      </p>
      <ul aria-label="Recovery codes" className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-fh-border bg-fh-surface-muted px-3 py-2 font-mono text-fh-sm text-fh-fg">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <Button variant="default" onClick={download}>Download</Button>
        <Button variant="primary" onClick={onDone}>I've saved them</Button>
      </div>
    </div>
  );
}

function PasswordDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; danger?: boolean;
  onConfirm: (password: string) => Promise<void>; onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(errorText(err, "Something went wrong"));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onCancel}
      title={title}
      description={message}
      footer={
        <>
          <Button variant="default" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} disabled={!password} onClick={() => void submit()}>{confirmLabel}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Your password" htmlFor="confirm-password">
          {(id) => <TextInput id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />}
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Dialog>
  );
}
