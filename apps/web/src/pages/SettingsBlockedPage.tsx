import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { avatarSrc, listBlockedUsers, setBlocked } from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { BlockedUser, User } from "../types";
import { Avatar, Button, EmptyState, PageHeading, RelativeTime, Skeleton, TextInput, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Settings → Blocked users (#258). Someone you block can't follow you or open
 * issues, pull requests, comments or reactions in your repositories, and
 * nothing they do notifies you.
 */
export function SettingsBlockedPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Blocked users · Settings · ForgeHub");
  const [users, setUsers] = useState<BlockedUser[] | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const load = () => listBlockedUsers(token).then((d) => setUsers(d.users)).catch(() => setUsers([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function block(e: React.FormEvent) {
    e.preventDefault();
    const h = handle.trim().replace(/^@/, "");
    if (!h) return;
    setBusy(true);
    try {
      await setBlocked(token, h, true);
      setHandle("");
      toast(`Blocked @${h}`, { tone: "success" });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't block", { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function unblock(h: string) {
    try {
      await setBlocked(token, h, false);
      setUsers((prev) => (prev ?? []).filter((u) => u.handle !== h));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't unblock", { tone: "danger" });
    }
  }

  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading
        title="Blocked users"
        description="A blocked user can't follow you, or open issues, pull requests, comments or reactions in your repositories. You won't be notified of anything they do."
        divider
      />
      <form onSubmit={block} className="mb-6 flex max-w-[440px] gap-2">
        <TextInput aria-label="Username to block" placeholder="Search by username" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <Button type="submit" variant="default" loading={busy} disabled={!handle.trim()}>Block user</Button>
      </form>
      {users === null ? (
        <Skeleton width="100%" height={72} />
      ) : users.length === 0 ? (
        <EmptyState bordered title="You haven't blocked anyone" />
      ) : (
        <ul className="divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
          {users.map((u) => (
            <li key={u.handle} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={u.displayName || u.handle} src={avatarSrc(u.handle, u.avatarKey)} size={32} />
              <div className="min-w-0 flex-1">
                <Link to={`/${u.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{u.handle}</Link>
                <p className="text-fh-xs text-fh-fg-muted">Blocked <RelativeTime date={u.blockedAt} /></p>
              </div>
              <Button size="sm" variant="default" onClick={() => void unblock(u.handle)}>Unblock</Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsLayout>
  );
}
