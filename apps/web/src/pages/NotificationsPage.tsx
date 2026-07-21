import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { deleteNotification, listNotifications, markAllNotificationsRead, markNotificationRead } from "../api";
import { Header } from "../components/Header";
import type { Notification, User } from "../types";
import {
  Avatar, Badge, Button, EmptyState, PageHeading, RelativeTime, Skeleton,
  TabNav, TabItem, Tooltip, cx, useToast,
} from "../ui";
import type { BadgeTone } from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

// ── local Octicon-style marks ─────────────────────────────────────────────────

function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const ISSUE = "M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z";
const PR = "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z";
const TAG = "M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z";
const CHECK = "M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.751.751 0 01.018-1.042.751.751 0 011.042-.018L6 10.94l6.72-6.72a.75.75 0 011.06 0z";
const TRASH = "M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25z";
const BELL ="M8 16a2 2 0 001.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 008 16z M8 1.5A3.5 3.5 0 004.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.018.018 0 00-.003.01l.001.006c0 .01.004.02.01.03a.265.265 0 00.189.097l.013.001h10.582l.013-.001a.265.265 0 00.189-.097.051.051 0 00.01-.03l.001-.006a.018.018 0 00-.003-.01l-1.703-2.557a1.75 1.75 0 01-.294-.97V5A3.5 3.5 0 008 1.5zM3 5a5 5 0 0110 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.518 1.518 0 0113.482 13H2.518a1.518 1.518 0 01-1.263-2.359l1.703-2.555A.25.25 0 003 7.947V5z";

function subjectIcon(type: Notification["subjectType"]) {
  if (type === "pull_request") return PR;
  if (type === "release") return TAG;
  return ISSUE;
}
function subjectColor(type: Notification["subjectType"]) {
  if (type === "pull_request") return "text-fh-success-fg";
  if (type === "release") return "text-fh-purple-fg";
  return "text-fh-accent-fg";
}

const REASON_LABEL: Record<Notification["reason"], string> = {
  assigned: "Assigned", comment: "Comment", review_requested: "Review requested", subscribed: "Subscribed",
};
const REASON_TONE: Record<Notification["reason"], BadgeTone> = {
  assigned: "warning", comment: "accent", review_requested: "purple", subscribed: "neutral",
};

function groupByRepo(items: Notification[]): Array<{ repo: string; items: Notification[] }> {
  const map = new Map<string, Notification[]>();
  for (const n of items) {
    if (!map.has(n.repo)) map.set(n.repo, []);
    map.get(n.repo)!.push(n);
  }
  return Array.from(map.entries()).map(([repo, items]) => ({ repo, items }));
}

export function NotificationsPage({ token, user, onLogout }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setLoading(true);
    listNotifications(token, true)
      .then((d) => setNotifications(d.notifications))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);
  const visible = useMemo(
    () => (filter === "unread" ? notifications.filter((n) => !n.read) : notifications),
    [notifications, filter],
  );
  const groups = useMemo(() => groupByRepo(visible), [visible]);

  async function markRead(id: string) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    await markNotificationRead(token, id).catch(() => {});
  }

  async function remove(id: string) {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    await deleteNotification(token, id).catch(() => {});
  }

  async function markAll() {
    setMarkingAll(true);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    await markAllNotificationsRead(token).catch(() => {});
    setMarkingAll(false);
    toast("All notifications marked as read", { tone: "success" });
  }

  return (
    <div className="min-h-screen bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[1000px] mx-auto px-4 py-8">
        <PageHeading
          title="Notifications"
          icon={<Icon path={BELL} size={20} />}
          description={unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up."}
          actions={
            unreadCount > 0 ? (
              <Button variant="default" leadingIcon={<Icon path={CHECK} size={14} />} loading={markingAll} onClick={markAll}>
                Mark all as read
              </Button>
            ) : undefined
          }
        />

        <TabNav aria-label="Filter notifications" className="mt-4 mb-5">
          <TabItem active={filter === "unread"} count={unreadCount} onClick={() => setFilter("unread")}>Unread</TabItem>
          <TabItem active={filter === "all"} count={notifications.length} onClick={() => setFilter("all")}>All</TabItem>
        </TabNav>

        {loading ? (
          <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton variant="block" width={8} height={8} className="rounded-full mt-1.5" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-fh-surface border border-fh-border rounded-md">
            <EmptyState
              icon={<Icon path={CHECK} size={32} />}
              title={filter === "unread" ? "You're all caught up" : "No notifications"}
              description={
                filter === "unread"
                  ? "No unread notifications. Switch to All to review everything."
                  : "Activity on repositories you own or collaborate on will show up here."
              }
            />
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(({ repo, items }) => {
              const [h, name] = repo.split("/");
              const repoUnread = items.filter((i) => !i.read).length;
              return (
                <section key={repo}>
                  <div className="flex items-center gap-2 mb-2 px-0.5">
                    <Avatar name={name || repo} size={18} square />
                    <Link to={`/${h}/${name}`} className="text-fh-sm font-semibold text-fh-fg hover:text-fh-accent-fg no-underline hover:underline">
                      {repo}
                    </Link>
                    {repoUnread > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-fh-xs font-semibold bg-fh-accent-muted text-fh-accent-fg ml-auto">
                        {repoUnread}
                      </span>
                    )}
                  </div>

                  <div className="bg-fh-surface border border-fh-border rounded-md overflow-hidden divide-y divide-fh-border">
                    {items.map((n) => (
                      <div
                        key={n.id}
                        className={cx(
                          "group flex items-start gap-3 pl-3 pr-3 py-3 border-l-2 transition-colors hover:bg-fh-surface-muted",
                          n.read ? "border-transparent" : "border-fh-accent-emphasis bg-fh-accent-muted/20",
                        )}
                      >
                        {/* Unread dot */}
                        <span className="shrink-0 mt-1.5 w-2.5 h-2.5 flex items-center justify-center" aria-hidden="true">
                          {!n.read && <span className="w-2 h-2 rounded-full bg-fh-accent-emphasis" />}
                        </span>

                        {/* Subject icon */}
                        <span className={cx("shrink-0 mt-0.5", subjectColor(n.subjectType))}>
                          <Icon path={subjectIcon(n.subjectType)} size={15} />
                        </span>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className={cx("text-fh-base leading-snug break-words", n.read ? "text-fh-fg-muted" : "text-fh-fg font-semibold")}>
                            {n.subjectTitle}
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge tone={REASON_TONE[n.reason]}>{REASON_LABEL[n.reason]}</Badge>
                            <span className="text-fh-xs text-fh-fg-subtle capitalize">{n.subjectType.replace("_", " ")}</span>
                            <span aria-hidden className="text-fh-fg-subtle">·</span>
                            <RelativeTime date={n.updatedAt} className="text-fh-xs text-fh-fg-subtle" />
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                          {!n.read && (
                            <Tooltip label="Mark as read">
                              <button
                                aria-label="Mark as read"
                                onClick={() => void markRead(n.id)}
                                className="p-1.5 rounded-md text-fh-fg-muted hover:text-fh-accent-fg hover:bg-fh-accent-muted cursor-pointer"
                              >
                                <Icon path={CHECK} size={14} />
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip label="Remove">
                            <button
                              aria-label="Remove notification"
                              onClick={() => void remove(n.id)}
                              className="p-1.5 rounded-md text-fh-fg-muted hover:text-fh-danger-fg hover:bg-fh-danger-muted cursor-pointer"
                            >
                              <Icon path={TRASH} size={14} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
