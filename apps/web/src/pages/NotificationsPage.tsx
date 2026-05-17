import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { deleteNotification, listNotifications, markAllNotificationsRead, markNotificationRead } from "../api";
import { Header } from "../components/Header";
import type { Notification, User } from "../types";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function IssueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function PRIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z" />
    </svg>
  );
}

function subjectIcon(type: string) {
  if (type === "pull_request") return <PRIcon />;
  if (type === "release") return <TagIcon />;
  return <IssueIcon />;
}

function subjectColor(type: string) {
  if (type === "pull_request") return "text-gh-success";
  if (type === "release") return "text-gh-purple";
  return "text-gh-accent";
}

function reasonLabel(reason: string) {
  switch (reason) {
    case "assigned": return "Assigned";
    case "comment": return "Commented";
    case "review_requested": return "Review requested";
    case "subscribed": return "Subscribed";
    default: return reason;
  }
}

function reasonColor(reason: string) {
  switch (reason) {
    case "assigned": return "bg-orange-50 text-orange-700 border-orange-200";
    case "comment": return "bg-blue-50 text-blue-700 border-blue-200";
    case "review_requested": return "bg-purple-50 text-purple-700 border-purple-200";
    default: return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

function groupByRepo(notifications: Notification[]): Array<{ repo: string; items: Notification[] }> {
  const map = new Map<string, Notification[]>();
  for (const n of notifications) {
    if (!map.has(n.repo)) map.set(n.repo, []);
    map.get(n.repo)!.push(n);
  }
  return Array.from(map.entries()).map(([repo, items]) => ({ repo, items }));
}

export function NotificationsPage({ token, user, onLogout }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);

  function load(all: boolean) {
    setLoading(true);
    listNotifications(token, all)
      .then((d) => setNotifications(d.notifications))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(showAll); }, [token, showAll]);

  async function markRead(id: string) {
    await markNotificationRead(token, id);
    setNotifications((prev) =>
      prev.map((n) => n.id === id ? { ...n, read: true } : n)
    );
  }

  async function remove(id: string) {
    await deleteNotification(token, id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  async function markAll() {
    setMarkingAll(true);
    await markAllNotificationsRead(token).catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setMarkingAll(false);
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const groups = groupByRepo(notifications);

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[1100px] mx-auto px-4 py-8">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gh-text">Notifications</h1>
            {unreadCount > 0 && (
              <p className="text-sm text-gh-muted mt-0.5">{unreadCount} unread</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                className="btn-default flex items-center gap-1.5 text-sm"
                onClick={markAll}
                disabled={markingAll}
              >
                <CheckIcon />
                {markingAll ? "Marking…" : "Mark all as read"}
              </button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 border-b border-gh-border mb-6">
          <button
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              !showAll
                ? "border-gh-accent text-gh-text font-semibold"
                : "border-transparent text-gh-muted hover:text-gh-text"
            }`}
            onClick={() => setShowAll(false)}
          >
            Unread
          </button>
          <button
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              showAll
                ? "border-gh-accent text-gh-text font-semibold"
                : "border-transparent text-gh-muted hover:text-gh-text"
            }`}
            onClick={() => setShowAll(true)}
          >
            All notifications
          </button>
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="card p-4 animate-pulse flex gap-3">
                <div className="w-4 h-4 bg-gray-200 rounded-full mt-1 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-3/4" />
                  <div className="h-3 bg-gray-100 rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="card py-24 text-center">
            <svg width="40" height="40" viewBox="0 0 16 16" fill="currentColor" className="mx-auto text-gh-muted mb-4 opacity-40">
              <path d="M8 16a2 2 0 001.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 008 16z" />
              <path fillRule="evenodd" d="M8 1.5A3.5 3.5 0 004.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.018.018 0 00-.003.01l.001.006c0 .01.004.02.01.03a.265.265 0 00.189.097l.013.001h10.582l.013-.001a.265.265 0 00.189-.097.051.051 0 00.01-.03l.001-.006a.018.018 0 00-.003-.01l-1.703-2.557a1.75 1.75 0 01-.294-.97V5A3.5 3.5 0 008 1.5zM3 5a5 5 0 0110 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.518 1.518 0 0113.482 13H2.518a1.518 1.518 0 01-1.263-2.359l1.703-2.555A.25.25 0 003 7.947V5z" />
            </svg>
            <p className="text-lg font-semibold text-gh-text">
              {showAll ? "No notifications" : "You're all caught up!"}
            </p>
            <p className="text-sm text-gh-muted mt-1">
              {showAll
                ? "Activity on your repositories will show up here."
                : "No unread notifications. Switch to 'All' to see everything."}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(({ repo, items }) => {
              const [handle, repoName] = repo.split("/");
              return (
                <div key={repo}>
                  {/* Repo header */}
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
                      <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
                    </svg>
                    <Link
                      to={`/${handle}/${repoName}`}
                      className="text-sm font-semibold text-gh-text hover:text-gh-accent no-underline hover:underline"
                    >
                      {repo}
                    </Link>
                    <span className="counter ml-1">{items.filter((i) => !i.read).length || items.length}</span>
                  </div>

                  {/* Notification items */}
                  <div className="card overflow-hidden divide-y divide-gh-border">
                    {items.map((notif) => (
                      <div
                        key={notif.id}
                        className={`flex items-start gap-3 px-4 py-3 group hover:bg-gh-bg transition-colors ${
                          notif.read ? "opacity-60" : ""
                        }`}
                      >
                        {/* Unread dot */}
                        <div className="flex-shrink-0 mt-1.5 w-2.5 h-2.5 flex items-center justify-center">
                          {!notif.read && (
                            <div className="w-2 h-2 rounded-full bg-gh-accent" />
                          )}
                        </div>

                        {/* Type icon */}
                        <div className={`flex-shrink-0 mt-0.5 ${subjectColor(notif.subjectType)}`}>
                          {subjectIcon(notif.subjectType)}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm leading-snug truncate ${notif.read ? "text-gh-muted" : "text-gh-text font-medium"}`}>
                            {notif.subjectTitle}
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={`inline-flex items-center text-xs px-1.5 py-0.5 rounded border ${reasonColor(notif.reason)}`}>
                              {reasonLabel(notif.reason)}
                            </span>
                            <span className="text-xs text-gh-muted">{timeAgo(notif.updatedAt)}</span>
                          </div>
                        </div>

                        {/* Actions — show on hover */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          {!notif.read && (
                            <button
                              title="Mark as read"
                              className="p-1.5 text-gh-muted hover:text-gh-accent hover:bg-gh-accent-muted rounded-md transition-colors"
                              onClick={() => void markRead(notif.id)}
                            >
                              <CheckIcon />
                            </button>
                          )}
                          <button
                            title="Remove"
                            className="p-1.5 text-gh-muted hover:text-gh-danger hover:bg-gh-danger-muted rounded-md transition-colors"
                            onClick={() => void remove(notif.id)}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
