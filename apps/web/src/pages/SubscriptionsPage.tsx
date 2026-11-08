import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSubscriptions, setThreadSubscribed } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { notificationHref } from "../lib/inbox";
import type { Notification, User } from "../types";
import { Button, EmptyState, PageHeading, RelativeTime, Skeleton, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Subscriptions (#258): the conversations that reach your inbox, and the ones
 * you unsubscribed from. You're subscribed by taking part; unsubscribing quiets
 * a conversation except when you're addressed directly.
 */
export function SubscriptionsPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Subscriptions · ForgeHub");
  const [data, setData] = useState<{ subscriptions: Notification[]; unsubscribed: Notification[] } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    listSubscriptions(token).then(setData).catch(() => setData({ subscriptions: [], unsubscribed: [] }));
  }, [token]);

  async function set(n: Notification, subscribed: boolean) {
    try {
      await setThreadSubscribed(token, n.id, subscribed);
      setData((prev) =>
        prev && {
          subscriptions: subscribed ? [n, ...prev.subscriptions] : prev.subscriptions.filter((x) => x.id !== n.id),
          unsubscribed: subscribed ? prev.unsubscribed.filter((x) => x.id !== n.id) : [n, ...prev.unsubscribed],
        },
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't change the subscription", { tone: "danger" });
    }
  }

  const list = (items: Notification[], subscribed: boolean) => (
    <ul className="divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
      {items.map((n) => (
        <li key={n.id} className="flex items-center gap-3 px-4 py-2.5 text-fh-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate text-fh-xs text-fh-fg-muted">{n.repo}{n.number != null && ` #${n.number}`}</p>
            <Link to={notificationHref(n)} className="block truncate text-fh-fg hover:text-fh-accent-fg">{n.subjectTitle}</Link>
          </div>
          <RelativeTime date={n.updatedAt} className="shrink-0 text-fh-xs text-fh-fg-muted" />
          <Button size="sm" variant="default" onClick={() => void set(n, !subscribed)}>{subscribed ? "Unsubscribe" : "Subscribe"}</Button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[900px] flex-1 px-4 py-8">
        <p className="mb-2 text-fh-sm">
          <Link to="/notifications" className="text-fh-accent-fg hover:underline">Notifications</Link> / Subscriptions
        </p>
        <PageHeading
          title="Subscriptions"
          description="Conversations you take part in reach your inbox. Unsubscribe to quiet one; you still hear when someone mentions you, assigns you or asks for your review."
          divider
        />
        {data === null ? (
          <Skeleton width="100%" height={120} />
        ) : (
          <>
            {data.subscriptions.length === 0 ? <EmptyState bordered title="No subscriptions yet" /> : list(data.subscriptions, true)}
            {data.unsubscribed.length > 0 && (
              <>
                <h2 className="mb-2 mt-8 text-fh-base font-semibold text-fh-fg">Unsubscribed</h2>
                {list(data.unsubscribed, false)}
              </>
            )}
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}
