import { describe, it, expect } from "vitest";
import { buildReviewerRows, requestableMembers } from "../pages/repo/pulls/reviewersModel";
import type { RepoMember } from "../api";
import type { RequestedReviewer, ReviewSummary, ReviewerSummary } from "../types";

function reviewer(author: string, overrides: Partial<ReviewerSummary> = {}): ReviewerSummary {
  return { author, state: "approved", stale: false, submittedAt: "2026-08-01T00:00:00Z", commitSha: "abc", ...overrides };
}

function summary(reviewers: ReviewerSummary[]): ReviewSummary {
  return { reviewers, approvals: 0, changesRequested: 0, commented: 0, staleCount: 0, unresolvedThreads: 0 };
}

function request(handle: string, overrides: Partial<RequestedReviewer> = {}): RequestedReviewer {
  return { handle, state: "requested", requestedBy: "alice", requestedAt: "2026-08-01T00:00:00Z", ...overrides };
}

function member(handle: string, role: RepoMember["role"]): RepoMember {
  return { id: `id-${handle}`, handle, displayName: null, role };
}

describe("buildReviewerRows", () => {
  it("lists requested reviewers first, oldest request first", () => {
    const rows = buildReviewerRows(summary([]), [
      request("late", { requestedAt: "2026-08-02T00:00:00Z" }),
      request("early", { requestedAt: "2026-08-01T00:00:00Z" }),
    ]);
    expect(rows.map((r) => r.handle)).toEqual(["early", "late"]);
    expect(rows[0]!.request?.state).toBe("requested");
    expect(rows[0]!.review).toBeNull();
  });

  it("collapses a person who was requested AND reviewed into one row with both facts", () => {
    const rows = buildReviewerRows(summary([reviewer("cara")]), [request("cara", { state: "reviewed" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request?.state).toBe("reviewed");
    expect(rows[0]!.review?.state).toBe("approved");
  });

  it("appends unrequested reviewers after the requested ones, in summary order", () => {
    const rows = buildReviewerRows(
      summary([reviewer("newest"), reviewer("older")]),
      [request("asked")],
    );
    expect(rows.map((r) => r.handle)).toEqual(["asked", "newest", "older"]);
    expect(rows[1]!.request).toBeNull();
  });

  it("handles missing summary and missing requests", () => {
    expect(buildReviewerRows(undefined, undefined)).toEqual([]);
    expect(buildReviewerRows(summary([reviewer("solo")]), undefined)).toHaveLength(1);
  });
});

describe("requestableMembers", () => {
  const members = [
    member("reader", "reader"),
    member("owner", "owner"),
    member("writer", "writer"),
    member("author", "writer"),
    member("me", "owner"),
    member("pending", "reader"),
  ];

  it("excludes the author, the viewer, and anyone with a pending request", () => {
    const out = requestableMembers(members, {
      author: "author",
      currentUser: "me",
      requested: [request("pending")],
    });
    expect(out.map((m) => m.handle)).toEqual(["owner", "writer", "reader"]);
  });

  it("keeps someone whose request was already fulfilled (re-requestable via picker)", () => {
    const out = requestableMembers(members, {
      author: "author",
      currentUser: "me",
      requested: [request("reader", { state: "reviewed" })],
    });
    expect(out.map((m) => m.handle)).toContain("reader");
  });

  it("sorts owners before writers before readers, A→Z within a role", () => {
    const out = requestableMembers(
      [member("zed", "owner"), member("amy", "owner"), member("bob", "reader"), member("cal", "writer")],
      { author: "nobody", currentUser: "me", requested: [] },
    );
    expect(out.map((m) => m.handle)).toEqual(["amy", "zed", "cal", "bob"]);
  });
});
