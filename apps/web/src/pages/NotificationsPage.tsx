import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listInbox, markAllNotificationsRead, notificationsAction } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { groupNotifications, notificationHref } from "../lib/inbox";
import { RepoIcon } from "./listShared";
import type { InboxAction, InboxReason, InboxView, Notification, User } from "../types";
import { Button, EmptyState, RelativeTime, Select, Skeleton, Tooltip, cx, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
  onUserChange?: (user: User) => void;
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
const INBOX = "M2.8 2.06A1.75 1.75 0 014.41 1h7.18c.7 0 1.333.417 1.61 1.06l2.74 6.395c.04.093.06.194.06.295v4.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25v-4.5c0-.101.02-.202.06-.295zm1.61.44a.25.25 0 00-.23.152L1.887 8H4.75a.75.75 0 01.6.3L6.625 10h2.75l1.275-1.7a.75.75 0 01.6-.3h2.863L11.82 2.652a.25.25 0 00-.23-.152zm10.09 7h-2.875l-1.275 1.7a.75.75 0 01-.6.3h-3.5a.75.75 0 01-.6-.3L4.375 9.5H1.5v3.75c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25z";
const BOOKMARK = "M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 01-1.227.579L8 11.722l-3.773 3.107A.751.751 0 013 14.25zm1.75-.25a.25.25 0 00-.25.25v9.91l3.023-2.489a.75.75 0 01.954 0l3.023 2.49V2.75a.25.25 0 00-.25-.25z";
const BELL_SLASH = "m4.182 4.31.016.011 10.104 7.316.013.01 1.375.996a.75.75 0 11-.88 1.214L13.626 13H2.518a1.516 1.516 0 01-1.263-2.36l1.703-2.554A.255.255 0 003 7.947V5.36L.31 3.413a.75.75 0 01.88-1.214zM6.5 14a.5.5 0 01-.5.5h4a.5.5 0 01-.5-.5zM2.519 11.5h9.035L4.5 6.395v1.552c0 .346-.102.683-.294.97l-1.703 2.556a.017.017 0 00-.003.01l.001.006c0 .002.002.004.004.006l.006.004.007.001zM8 1.5c-.997 0-1.895.416-2.534 1.086A.75.75 0 014.38 1.55 5 5 0 0113 5v2.373a.75.75 0 01-1.5 0V5A3.5 3.5 0 008 1.5z";
const DOT = "M8 4a4 4 0 110 8 4 4 0 010-8z";

function subjectIcon(n: Notification): { path: string; color: string } {
  if (n.subjectType === "release") return { path: TAG, color: "text-fh-fg-muted" };
  const path = n.subjectType === "pull_request" ? PR : ISSUE;
  if (n.state === "merged") return { path, color: "text-fh-purple-fg" };
  if (n.state === "closed") return { path, color: n.subjectType === "issue" ? "text-fh-purple-fg" : "text-fh-danger-fg" };
  return { path, color: "text-fh-success-fg" };
}

const REASON_LABEL: Record<Notification["reason"], string> = {
  assigned: "assigned", comment: "comment", review_requested: "review requested", subscribed: "subscribed", mentioned: "mention",
  team_mentioned: "team mention",
};

const VIEWS: Array<{ view: InboxView; label: string; icon: string }> = [
  { view: "inbox", label: "Inbox", icon: INBOX },
  { view: "saved", label: "Saved", icon: BOOKMARK },
  { view: "done", label: "Done", icon: CHECK },
];

const REASONS: Array<{ reason: InboxReason; label: string }> = [
  { reason: "assigned", label: "Assigned" },
  { reason: "participating", label: "Participating" },
  { reason: "mentioned", label: "Mentioned" },
  { reason: "team_mentioned", label: "Team mentioned" },
  { reason: "review_requested", label: "Review requested" },
  { reason: "watching", label: "Watching" },
];

/**
 * The notifications inbox (#258), GitHub's: Inbox / Saved / Done, filters by
 * reason and repository, grouping by date or repository, and per-row and bulk
 * actions (done, save, read/unread, unsubscribe).
 */
export function NotificationsPage({ token, user, onLogout }: Props) {
  useDocumentTitle("Notifications · ForgeHub");
  const [params, setParams] = useSearchParams();
  const view = (["saved", "done"].includes(params.get("view") ?? "") ? params.get("view") : "inbox") as InboxView;
  const reason = (REASONS.find((r) => r.reason === params.get("reason"))?.reason ?? undefined) as InboxReason | undefined;
  const repo = params.get("repo") ?? undefined;
  const unread = params.get("unread") === "1";
  const groupBy = params.get("group") === "repo" ? "repo" : "date";
  const oldest = params.get("sort") === "oldest";

  const [items, setItems] = useState<Notification[] | null>(null);
  const [repos, setRepos] = useState<Array<{ repo: string; count: number }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(() => {
    listInbox(token, { view, reason, repo, unread, oldest })
      .then((d) => {
        setItems(d.notifications);
        setRepos(d.repos);
      })
      .catch(() => setItems([]));
  }, [token, view, reason, repo, unread, oldest]);

  useEffect(() => {
    setItems(null);
    setSelected(new Set());
    load();
  }, [load]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  /** Apply an action locally (what leaves this view drops out), then on the server. */
  async function act(ids: string[], action: InboxAction) {
    if (ids.length === 0) return;
    const leaves =
      (view === "inbox" && (action === "done" || action === "unsubscribe")) ||
      (view === "done" && action === "undone") ||
      (view === "saved" && action === "unsave") ||
      (unread && (action === "read" || action === "done"));
    setItems((prev) =>
      (prev ?? [])
        .filter((n) => !(leaves && ids.includes(n.id)))
        .map((n) =>
          !ids.includes(n.id)
            ? n
            : {
                ...n,
                read: action === "read" || action === "done" || action === "unsubscribe" ? true : action === "unread" ? false : n.read,
                saved: action === "save" ? true : action === "unsave" ? false : n.saved,
                done: action === "done" || action === "unsubscribe" ? true : action === "undone" ? false : n.done,
              },
        ),
    );
    setSelected(new Set());
    try {
      await notificationsAction(token, ids, action);
      if (action === "unsubscribe") toast(ids.length === 1 ? "Unsubscribed from this conversation" : `Unsubscribed from ${ids.length} conversations`, { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update notifications", { tone: "danger" });
      load();
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await markAllNotificationsRead(token);
      load();
    } finally {
      setBusy(false);
    }
  }

  function open(n: Notification) {
    if (!n.read) void act([n.id], "read");
    navigate(notificationHref(n));
  }

  const groups = useMemo(() => {
    const g = groupNotifications(items ?? [], groupBy);
    // Date buckets come newest first; oldest-first reads them the other way round.
    return oldest && groupBy === "date" ? [...g].reverse() : g;
  }, [items, groupBy, oldest]);
  const allIds = (items ?? []).map((n) => n.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const sel = [...selected];
  const selItems = (items ?? []).filter((n) => selected.has(n.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-4 py-6 md:flex-row">
        {/* Sidebar: views, filters, repositories */}
        <nav aria-label="Notifications" className="w-full flex-shrink-0 text-fh-sm md:w-60">
          <ul>
            {VIEWS.map((v) => (
              <li key={v.view}>
                <Link
                  to={v.view === "inbox" ? "/notifications" : `/notifications?view=${v.view}`}
                  aria-current={view === v.view && !reason && !repo ? "page" : undefined}
                  className={cx(
                    "flex items-center gap-2 rounded-md px-3 py-1.5 no-underline",
                    view === v.view && !reason && !repo ? "bg-fh-surface-muted font-semibold text-fh-fg" : "text-fh-fg hover:bg-fh-surface-muted",
                  )}
                >
                  <Icon path={v.icon} className="text-fh-fg-muted" />
                  {v.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mb-1 mt-4 px-3 text-fh-xs font-semibold text-fh-fg-muted">Filters</p>
          <ul>
            {REASONS.map((r) => (
              <li key={r.reason}>
                <button
                  type="button"
                  aria-pressed={reason === r.reason}
                  onClick={() => setParam("reason", reason === r.reason ? null : r.reason)}
                  className={cx(
                    "w-full rounded-md px-3 py-1.5 text-left",
                    reason === r.reason ? "bg-fh-surface-muted font-semibold text-fh-fg" : "text-fh-fg hover:bg-fh-surface-muted",
                  )}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
          {repos.length > 0 && (
            <>
              <p className="mb-1 mt-4 px-3 text-fh-xs font-semibold text-fh-fg-muted">Repositories</p>
              <ul>
                {repos.map((r) => (
                  <li key={r.repo}>
                    <button
                      type="button"
                      aria-pressed={repo === r.repo}
                      onClick={() => setParam("repo", repo === r.repo ? null : r.repo)}
                      className={cx(
                        "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left",
                        repo === r.repo ? "bg-fh-surface-muted font-semibold text-fh-fg" : "text-fh-fg hover:bg-fh-surface-muted",
                      )}
                    >
                      <RepoIcon size={14} className="shrink-0 text-fh-fg-muted" />
                      <span className="min-w-0 flex-1 truncate">{r.repo}</span>
                      <span className="text-fh-xs text-fh-fg-muted">{r.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-4 border-t border-fh-border-muted px-3 pt-3 text-fh-xs">
            <Link to="/notifications/watching" className="block text-fh-accent-fg hover:underline">Watching</Link>
            <Link to="/notifications/subscriptions" className="mt-1 block text-fh-accent-fg hover:underline">Subscriptions</Link>
            <Link to="/settings/notifications" className="mt-1 block text-fh-accent-fg hover:underline">Manage notification settings</Link>
          </div>
        </nav>

        <main className="min-w-0 flex-1">
          {/* Toolbar: select all, then bulk actions or the view's own controls */}
          <div className="flex flex-wrap items-center gap-2 rounded-t-md border border-fh-border bg-fh-canvas px-4 py-2">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(allIds))}
              disabled={allIds.length === 0}
            />
            {sel.length > 0 ? (
              <>
                <span className="mr-2 text-fh-sm text-fh-fg-muted">{sel.length} selected</span>
                {view === "done" ? (
                  <Button size="sm" variant="default" onClick={() => void act(sel, "undone")}>Move to inbox</Button>
                ) : (
                  <Button size="sm" variant="default" leadingIcon={<Icon path={CHECK} size={14} />} onClick={() => void act(sel, "done")}>Done</Button>
                )}
                {selItems.some((n) => !n.read) ? (
                  <Button size="sm" variant="default" onClick={() => void act(sel, "read")}>Mark as read</Button>
                ) : (
                  <Button size="sm" variant="default" onClick={() => void act(sel, "unread")}>Mark as unread</Button>
                )}
                {selItems.every((n) => n.saved) ? (
                  <Button size="sm" variant="default" onClick={() => void act(sel, "unsave")}>Unsave</Button>
                ) : (
                  <Button size="sm" variant="default" onClick={() => void act(sel, "save")}>Save</Button>
                )}
                <Button size="sm" variant="default" onClick={() => void act(sel, "unsubscribe")}>Unsubscribe</Button>
              </>
            ) : (
              <>
                <span className="text-fh-sm font-semibold text-fh-fg">
                  {VIEWS.find((v) => v.view === view)!.label}
                  {reason && ` · ${REASONS.find((r) => r.reason === reason)!.label}`}
                  {repo && ` · ${repo}`}
                </span>
                {(reason || repo) && (
                  <button type="button" className="text-fh-xs text-fh-accent-fg hover:underline" onClick={() => setParams(view === "inbox" ? {} : { view })}>
                    Clear filters
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={unread}
                    onClick={() => setParam("unread", unread ? null : "1")}
                    className={cx(
                      "rounded-md border px-2 py-0.5 text-fh-xs",
                      unread ? "border-fh-accent-emphasis bg-fh-accent-muted text-fh-fg" : "border-fh-border text-fh-fg-muted hover:text-fh-fg",
                    )}
                  >
                    Unread
                  </button>
                  <div className="w-44">
                    <Select sizing="sm" aria-label="Group by" value={groupBy} onChange={(e) => setParam("group", e.target.value === "repo" ? "repo" : null)}>
                      <option value="date">Group by: Date</option>
                      <option value="repo">Group by: Repository</option>
                    </Select>
                  </div>
                  <div className="w-36">
                    <Select sizing="sm" aria-label="Sort" value={oldest ? "oldest" : "newest"} onChange={(e) => setParam("sort", e.target.value === "oldest" ? "oldest" : null)}>
                      <option value="newest">Newest first</option>
                      <option value="oldest">Oldest first</option>
                    </Select>
                  </div>
                  {view === "inbox" && (items ?? []).some((n) => !n.read) && (
                    <Button size="sm" variant="default" loading={busy} onClick={() => void markAllRead()}>Mark all as read</Button>
                  )}
                </div>
              </>
            )}
          </div>

          {items === null ? (
            <div className="space-y-px border-x border-b border-fh-border bg-fh-surface p-4">
              {[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={44} />)}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-b-md border-x border-b border-fh-border bg-fh-surface">
              <EmptyState
                icon={<Icon path={view === "saved" ? BOOKMARK : CHECK} size={32} />}
                title={view === "inbox" && !reason && !repo && !unread ? "All caught up!" : "No notifications here"}
                description={
                  view === "saved"
                    ? "Save notifications to come back to them later."
                    : view === "done"
                      ? "Notifications you mark as done show up here."
                      : "New activity on things you watch or take part in shows up here."
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-b-md border-x border-b border-fh-border bg-fh-surface">
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h2 className="flex items-center gap-2 border-b border-fh-border-muted bg-fh-canvas px-4 py-1.5 text-fh-xs font-semibold text-fh-fg-muted">
                    {groupBy === "repo" ? (
                      <>
                        <RepoIcon size={12} />
                        <Link to={`/${g.label}`} className="text-fh-fg hover:text-fh-accent-fg">{g.label}</Link>
                      </>
                    ) : (
                      g.label
                    )}
                  </h2>
                  <ul className="divide-y divide-fh-border-muted">
                    {g.items.map((n) => {
                      const icon = subjectIcon(n);
                      return (
                        <li
                          key={n.id}
                          className={cx("group flex items-center gap-3 px-4 py-2.5 hover:bg-fh-surface-muted", !n.read && "bg-fh-accent-muted/20")}
                        >
                          <input type="checkbox" aria-label={`Select ${n.subjectTitle}`} checked={selected.has(n.id)} onChange={() => toggle(n.id)} />
                          <span className="w-2.5 shrink-0 text-fh-accent-emphasis" aria-label={n.read ? undefined : "Unread"}>
                            {!n.read && <Icon path={DOT} size={10} />}
                          </span>
                          <Icon path={icon.path} className={cx("shrink-0", icon.color)} />
                          <button type="button" onClick={() => open(n)} className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-fh-xs text-fh-fg-muted">
                              {n.repo}
                              {n.number != null && ` #${n.number}`}
                              {n.tag && ` ${n.tag}`}
                            </span>
                            <span className={cx("block truncate text-fh-sm", n.read ? "text-fh-fg-muted" : "font-semibold text-fh-fg")}>
                              {n.subjectTitle}
                            </span>
                          </button>
                          <span className="hidden shrink-0 text-fh-xs text-fh-fg-muted sm:inline">{REASON_LABEL[n.reason]}</span>
                          {n.saved && <Icon path={BOOKMARK} size={14} className="shrink-0 text-fh-warning-fg" />}
                          <RelativeTime date={n.updatedAt} className="w-20 shrink-0 text-right text-fh-xs text-fh-fg-muted group-hover:hidden" />
                          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                            {view === "done" ? (
                              <RowAction label="Move to inbox" path={INBOX} onClick={() => void act([n.id], "undone")} />
                            ) : (
                              <RowAction label="Done" path={CHECK} onClick={() => void act([n.id], "done")} />
                            )}
                            <RowAction label="Unsubscribe" path={BELL_SLASH} onClick={() => void act([n.id], "unsubscribe")} />
                            <RowAction label={n.saved ? "Unsave" : "Save"} path={BOOKMARK} onClick={() => void act([n.id], n.saved ? "unsave" : "save")} />
                            <RowAction label={n.read ? "Mark as unread" : "Mark as read"} path={DOT} onClick={() => void act([n.id], n.read ? "unread" : "read")} />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </main>
      </div>
      <Footer />
    </div>
  );
}

function RowAction({ label, path, onClick }: { label: string; path: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="rounded-md p-1.5 text-fh-fg-muted hover:bg-fh-accent-muted hover:text-fh-accent-fg"
      >
        <Icon path={path} size={14} />
      </button>
    </Tooltip>
  );
}
