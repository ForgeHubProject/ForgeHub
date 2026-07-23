import { useEffect, useState } from "react";
import { listSessions, revokeOtherSessions, revokeSession } from "../api";
import { Header } from "../components/Header";
import { deviceLabel } from "../lib/deviceLabel";
import type { SessionInfo, User } from "../types";
import {
  Badge, Button, ConfirmDialog, EmptyState, PageHeading, RelativeTime, Skeleton, useToast,
} from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const DEVICE = "M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.727c.099 1.041.52 1.872 1.292 2.63a.75.75 0 0 1-.53 1.28h-6.57a.75.75 0 0 1-.53-1.28c.771-.758 1.193-1.589 1.292-2.63H1.75A1.75 1.75 0 0 1 0 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z";

export function SettingsSessionsPage({ token, user, onLogout }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<SessionInfo | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const { toast } = useToast();

  function load() {
    setSessions(null);
    listSessions(token)
      .then((d) => setSessions(d.sessions))
      .catch(() => setSessions([]));
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  async function handleRevoke() {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      await revokeSession(token, pendingRevoke.id);
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== pendingRevoke.id) : prev));
      toast("Signed out that device", { tone: "success" });
      setPendingRevoke(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to revoke session", { tone: "danger" });
    } finally {
      setRevoking(false);
    }
  }

  async function handleRevokeAll() {
    setRevokingAll(true);
    try {
      const { revoked } = await revokeOtherSessions(token);
      setSessions((prev) => (prev ? prev.filter((s) => s.current) : prev));
      toast(revoked > 0 ? `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}` : "No other sessions to sign out", { tone: "success" });
      setConfirmAll(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to sign out everywhere", { tone: "danger" });
    } finally {
      setRevokingAll(false);
    }
  }

  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <div className="min-h-screen bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[900px] mx-auto px-4 py-8">
        <PageHeading
          title="Active sessions"
          icon={<Icon path={DEVICE} size={20} />}
          description="Every device signed in to your account. Revoke one to sign it out, or sign out everywhere else at once."
          actions={
            <Button
              variant="danger"
              onClick={() => setConfirmAll(true)}
              disabled={others.length === 0}
            >
              Sign out everywhere else
            </Button>
          }
          divider
        />

        {sessions === null ? (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center justify-between px-4 py-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="bg-fh-surface border border-fh-border rounded-md">
            <EmptyState
              icon={<Icon path={DEVICE} size={32} />}
              title="No active sessions"
              description="Sessions started before this feature was added aren't listed here and can't be revoked individually — change your password to invalidate them."
            />
          </div>
        ) : (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-4 px-4 py-4">
                <div className="min-w-0 flex items-start gap-3">
                  <span className="text-fh-fg-muted mt-0.5 shrink-0"><Icon path={DEVICE} size={18} /></span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg truncate">{deviceLabel(s.userAgent)}</span>
                      {s.current && <Badge tone="success">This device</Badge>}
                    </div>
                    {s.userAgent && <p className="text-fh-xs font-mono text-fh-fg-muted mt-1 break-all">{s.userAgent}</p>}
                    <p className="text-fh-xs text-fh-fg-subtle mt-1.5 flex items-center gap-1.5 flex-wrap">
                      {s.ip && <><span className="font-mono">{s.ip}</span><span aria-hidden>·</span></>}
                      <span>Signed in <RelativeTime date={s.createdAt} /></span>
                      <span aria-hidden>·</span>
                      <span>Last active <RelativeTime date={s.lastSeenAt} /></span>
                    </p>
                  </div>
                </div>
                {s.current ? (
                  <span className="text-fh-xs text-fh-fg-subtle mt-1 shrink-0">Current</span>
                ) : (
                  <Button variant="danger" size="sm" onClick={() => setPendingRevoke(s)}>Revoke</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingRevoke && (
        <ConfirmDialog
          title="Sign out this device"
          message={<>Sign out <span className="font-semibold">{deviceLabel(pendingRevoke.userAgent)}</span>? That device will need to sign in again.</>}
          confirmLabel="Sign out device"
          loading={revoking}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setPendingRevoke(null)}
        />
      )}

      {confirmAll && (
        <ConfirmDialog
          title="Sign out everywhere else"
          message="Sign out of every other session? This device stays signed in; all other devices will need to sign in again."
          confirmLabel="Sign out others"
          loading={revokingAll}
          onConfirm={() => void handleRevokeAll()}
          onCancel={() => setConfirmAll(false)}
        />
      )}
    </div>
  );
}
