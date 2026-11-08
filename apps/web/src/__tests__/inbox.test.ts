import { describe, it, expect } from "vitest";
import { groupNotifications, notificationHref } from "../lib/inbox";
import type { Notification } from "../types";

const n = (id: string, updatedAt: string, repo = "acme/poster"): Notification => ({
  id, subjectType: "issue", subjectId: id, subjectTitle: id, reason: "comment", read: false, repo, updatedAt, number: 1,
});

describe("notificationHref", () => {
  it("leads to the issue, pull request or releases", () => {
    expect(notificationHref({ repo: "acme/poster", subjectType: "issue", number: 4 })).toBe("/acme/poster/issues/4");
    expect(notificationHref({ repo: "acme/poster", subjectType: "pull_request", number: 9 })).toBe("/acme/poster/pulls/9");
    expect(notificationHref({ repo: "acme/poster", subjectType: "release", number: null })).toBe("/acme/poster/releases");
  });
});

describe("groupNotifications", () => {
  const now = new Date(2026, 10, 7, 12, 0);
  it("buckets by date, newest bucket first", () => {
    const items = [
      n("old", new Date(2026, 7, 1).toISOString()),
      n("today", new Date(2026, 10, 7, 9).toISOString()),
      n("yesterday", new Date(2026, 10, 6, 22).toISOString()),
      n("week", new Date(2026, 10, 3).toISOString()),
    ];
    expect(groupNotifications(items, "date", now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["today"]], ["Yesterday", ["yesterday"]], ["This week", ["week"]], ["Older", ["old"]],
    ]);
  });

  it("groups by repository in list order", () => {
    const items = [n("a", "2026-11-07T00:00:00Z", "b/two"), n("b", "2026-11-06T00:00:00Z", "a/one"), n("c", "2026-11-05T00:00:00Z", "b/two")];
    expect(groupNotifications(items, "repo", now).map((g) => [g.label, g.items.length])).toEqual([["b/two", 2], ["a/one", 1]]);
  });
});
