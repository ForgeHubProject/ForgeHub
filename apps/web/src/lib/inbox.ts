import type { Notification } from "../types";

/** Where a notification leads (#258): its issue, pull request or the releases page. */
export function notificationHref(n: Pick<Notification, "repo" | "subjectType" | "number">): string {
  if (n.subjectType === "issue" && n.number != null) return `/${n.repo}/issues/${n.number}`;
  if (n.subjectType === "pull_request" && n.number != null) return `/${n.repo}/pulls/${n.number}`;
  if (n.subjectType === "release") return `/${n.repo}/releases`;
  return `/${n.repo}`;
}

export type InboxGroup = { key: string; label: string; items: Notification[] };

/**
 * GitHub's inbox grouping (#258): by date (Today, Yesterday, This week, This
 * month, Older) or by repository, keeping the list's order within each group.
 */
export function groupNotifications(items: Notification[], by: "date" | "repo", now = new Date()): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const dateBucket = (iso: string): [string, string] => {
    const t = new Date(iso).getTime();
    if (t >= startOfDay) return ["0", "Today"];
    if (t >= startOfDay - DAY) return ["1", "Yesterday"];
    if (t >= startOfDay - 6 * DAY) return ["2", "This week"];
    if (t >= startOfDay - 29 * DAY) return ["3", "This month"];
    return ["4", "Older"];
  };
  for (const n of items) {
    const [key, label] = by === "repo" ? [n.repo, n.repo] : dateBucket(n.updatedAt);
    const g = groups.get(key) ?? { key, label, items: [] };
    g.items.push(n);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  return by === "date" ? out.sort((a, b) => a.key.localeCompare(b.key)) : out;
}
