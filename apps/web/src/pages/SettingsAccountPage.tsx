import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { deleteAccount, exportAccount, renameAccount } from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { User } from "../types";
import { Button, ConfirmDialog, Dialog, Field, TextInput, cx, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = { token: string; user: User; onLogout: () => void; onUserChange: (u: User) => void };

/**
 * Settings → Account (#258): change your username, export your data, delete
 * your account. GitHub's layout: a section each, the deletion in red.
 */
export function SettingsAccountPage({ token, user, onLogout, onUserChange }: Props) {
  useDocumentTitle("Account · Settings · ForgeHub");
  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <Section title="Change username" first />
      <ChangeUsername token={token} user={user} onUserChange={onUserChange} />

      <Section title="Export account data" />
      <ExportData token={token} handle={user.handle} />

      <Section title="Delete account" danger />
      <DeleteAccount token={token} user={user} onLogout={onLogout} />
    </SettingsLayout>
  );
}

function Section({ title, first, danger }: { title: string; first?: boolean; danger?: boolean }) {
  return (
    <h2 className={cx("mb-4 border-b border-fh-border pb-2 text-fh-xl font-semibold", danger ? "text-fh-danger-fg" : "text-fh-fg", !first && "mt-10")}>
      {title}
    </h2>
  );
}

function ChangeUsername({ token, user, onUserChange }: { token: string; user: User; onUserChange: (u: User) => void }) {
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  async function rename() {
    setBusy(true);
    setError(null);
    try {
      const res = await renameAccount(token, handle.trim());
      onUserChange({ ...user, handle: res.handle });
      toast(`You're now @${res.handle}`, { tone: "success" });
      setEditing(false);
      setHandle("");
      navigate("/settings/account", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change your username");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-fh-sm text-fh-fg-muted">
        Changing your username moves your repositories with you. Their old addresses keep redirecting, on the web and for git,
        until someone else takes the name. Your old profile address does not redirect.
      </p>
      {!editing ? (
        <Button variant="default" onClick={() => setEditing(true)}>Change username</Button>
      ) : (
        <form
          className="flex max-w-[440px] flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (handle.trim()) setConfirming(true);
          }}
        >
          <Field label="New username" htmlFor="new-username" hint={`Currently @${user.handle}`}>
            {(id) => <TextInput id={id} value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={39} autoFocus />}
          </Field>
          {error && <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!handle.trim()}>Change my username</Button>
            <Button variant="invisible" onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}
      {confirming && (
        <ConfirmDialog
          title="Really change your username?"
          message={`@${user.handle} becomes @${handle.trim().toLowerCase()}. Links to your profile under the old name will stop working, and someone else may claim it.`}
          confirmLabel="Change my username"
          tone="danger"
          loading={busy}
          onConfirm={() => void rename()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function ExportData({ token, handle }: { token: string; handle: string }) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function download() {
    setBusy(true);
    try {
      const data = await exportAccount(token);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `forgehub-${handle}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-fh-sm text-fh-fg-muted">
        Download your profile, repositories' details, issues, pull requests, comments, stars and follows as a JSON file.
        Repository contents you can clone with git.
      </p>
      <Button variant="default" loading={busy} onClick={() => void download()}>Export your data</Button>
    </div>
  );
}

function DeleteAccount({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(token, password, confirm.trim());
      onLogout();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete your account");
      setBusy(false);
    }
  }

  const ready = confirm.trim().toLowerCase() === user.handle.toLowerCase() && password.length > 0;
  return (
    <div>
      <p className="mb-3 text-fh-sm text-fh-fg-muted">
        Once you delete your account, there is no going back. Your personal repositories are deleted. Issues, pull requests
        and comments you wrote in other repositories stay, credited to @ghost.
      </p>
      <Button variant="danger" onClick={() => setOpen(true)}>Delete your account</Button>
      {open && (
        <Dialog
          open
          onClose={busy ? () => {} : () => setOpen(false)}
          title="Are you sure you want to do this?"
          footer={
            <>
              <Button variant="default" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button variant="danger" loading={busy} disabled={!ready} onClick={() => void remove()}>Delete this account</Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="rounded-md border border-fh-danger-emphasis bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-fg">
              This deletes @{user.handle} and its personal repositories for good.
            </p>
            <Field label={`Type your username, ${user.handle}, to confirm`} htmlFor="delete-confirm">
              {(id) => <TextInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
            </Field>
            <Field label="Your password" htmlFor="delete-password">
              {(id) => <TextInput id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
            </Field>
            {error && <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
