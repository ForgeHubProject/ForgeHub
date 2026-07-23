import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    issue: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    issueComment: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestComment: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestReview: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { authHeader } from "./helpers/server.js";
import { bucketContributions } from "../routes/profile.js";
import type { FastifyInstance } from "fastify";

// ─── Pure bucketing helper ────────────────────────────────────────────────────

describe("bucketContributions()", () => {
  it("returns an empty result for no activity", () => {
    expect(bucketContributions([])).toEqual({ days: [], total: 0 });
  });

  it("buckets timestamps into exact per-UTC-day counts, sorted ascending", () => {
    const ts = [
      new Date("2026-03-01T09:00:00Z"),
      new Date("2026-03-01T23:59:59Z"),
      new Date("2026-03-03T00:00:00Z"),
      new Date("2026-03-02T12:00:00Z"),
      new Date("2026-03-01T00:00:01Z"),
    ];
    const out = bucketContributions(ts);
    expect(out.total).toBe(5);
    expect(out.days).toEqual([
      { date: "2026-03-01", count: 3 },
      { date: "2026-03-02", count: 1 },
      { date: "2026-03-03", count: 1 },
    ]);
  });

  it("keys by UTC date (a late-UTC timestamp does not bleed into the next local day)", () => {
    const out = bucketContributions([new Date("2026-06-15T23:30:00Z")]);
    expect(out.days).toEqual([{ date: "2026-06-15", count: 1 }]);
  });

  it("ignores invalid dates", () => {
    const out = bucketContributions([new Date("nope"), new Date("2026-01-02T00:00:00Z")]);
    expect(out).toEqual({ days: [{ date: "2026-01-02", count: 1 }], total: 1 });
  });
});

// ─── Endpoint ─────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  app = await buildServer();
}, 30_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.issueComment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pullRequestComment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([] as never);
});

describe("GET /users/:handle/contributions", () => {
  it("404s for an unknown handle", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({ method: "GET", url: "/users/ghost/contributions" });
    expect(res.statusCode).toBe(404);
  });

  it("aggregates all five authorship sources into per-day counts", async () => {
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      { createdAt: new Date("2026-03-01T10:00:00Z") },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { createdAt: new Date("2026-03-01T14:00:00Z") },
    ] as never);
    vi.mocked(prisma.issueComment.findMany).mockResolvedValue([
      { createdAt: new Date("2026-03-02T08:00:00Z") },
    ] as never);
    vi.mocked(prisma.pullRequestComment.findMany).mockResolvedValue([
      { createdAt: new Date("2026-03-02T09:00:00Z") },
    ] as never);
    vi.mocked(prisma.pullRequestReview.findMany).mockResolvedValue([
      { submittedAt: new Date("2026-03-02T10:00:00Z") },
      { submittedAt: null }, // pending review — must be ignored
    ] as never);

    const res = await app.inject({ method: "GET", url: "/users/alice/contributions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.days).toEqual([
      { date: "2026-03-01", count: 2 },
      { date: "2026-03-02", count: 3 },
    ]);
  });

  it("passes the requested [from,to] window into every source query", async () => {
    await app.inject({
      method: "GET",
      url: "/users/alice/contributions?from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z",
    });
    const arg = vi.mocked(prisma.issue.findMany).mock.calls[0]![0] as {
      where: { createdAt: { gte: Date; lte: Date } };
    };
    expect(arg.where.createdAt.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(arg.where.createdAt.lte.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    // Reviews filter on submittedAt, not createdAt.
    const revArg = vi.mocked(prisma.pullRequestReview.findMany).mock.calls[0]![0] as {
      where: { submittedAt: { gte: Date; lte: Date } };
    };
    expect(revArg.where.submittedAt.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("defaults to roughly the last 12 months when no range is given", async () => {
    await app.inject({ method: "GET", url: "/users/alice/contributions" });
    const arg = vi.mocked(prisma.issue.findMany).mock.calls[0]![0] as {
      where: { createdAt: { gte: Date; lte: Date } };
    };
    const spanDays = (arg.where.createdAt.lte.getTime() - arg.where.createdAt.gte.getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(360);
    expect(spanDays).toBeLessThan(370);
  });

  // ── Visibility: private activity never leaks to viewers who can't read the repo ─
  //
  // The mock honors the readable-repo filter the route builds: it returns the one
  // private-repo issue (owned by user-1) only when the query's repo predicate
  // admits an owner match. This proves the exclusion end-to-end.
  function honorVisibility() {
    const impl = (args: unknown) => {
      const or = (args as { where?: { repo?: { OR?: Array<{ ownerId?: string }> } } })?.where?.repo?.OR ?? [];
      const ownerAllowed = or.some((c) => c.ownerId === "user-1");
      return Promise.resolve(ownerAllowed ? [{ createdAt: new Date("2026-05-01T10:00:00Z") }] : []);
    };
    vi.mocked(prisma.issue.findMany).mockImplementation(impl as never);
  }

  it("hides private-repo activity from a guest (stranger)", async () => {
    honorVisibility();
    const res = await app.inject({ method: "GET", url: "/users/alice/contributions" });
    expect(res.json().total).toBe(0);
  });

  it("hides private-repo activity from a different signed-in user", async () => {
    honorVisibility();
    const other = await authHeader(app, "user-2");
    const res = await app.inject({
      method: "GET", url: "/users/alice/contributions", headers: { authorization: other },
    });
    expect(res.json().total).toBe(0);
  });

  it("shows the owner their own private-repo activity", async () => {
    honorVisibility();
    const self = await authHeader(app, "user-1");
    const res = await app.inject({
      method: "GET", url: "/users/alice/contributions", headers: { authorization: self },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.days).toEqual([{ date: "2026-05-01", count: 1 }]);
  });
});

// ── Org-repo visibility (issue #114 follow-up) ──────────────────────────────────
//
// Regression for the round-4 integration finding: the contributions readable-repo
// predicate predated organizations, so a user's OWN authored activity in a PRIVATE
// org repo they can fully read (via org OWNER membership or a team grant) was
// silently dropped — their contribution total stayed 0. The predicate now mirrors
// repo-access.ts `canRead`'s full readable set. These tests model a PRIVATE org
// repo (authored issue by the profile owner, alice = user-1) whose ONLY readers are
// an org OWNER ("org-owner") and a team member ("team-reader"), and assert the
// authored activity now surfaces for those principals while a stranger/guest is
// still excluded — the visibility guarantee is preserved (never over-count/leak).
describe("GET /users/:handle/contributions — org-repo visibility", () => {
  // The mock honors the readable-repo filter the route builds for the CURRENT
  // viewer: it returns alice's one private-org-repo issue only when the query's
  // `repo.OR` carries a grant this modeled repo actually confers —
  //   org OWNER "org-owner", or team member "team-reader".
  function honorOrgVisibility() {
    const impl = (args: unknown) => {
      const or =
        (args as { where?: { repo?: { OR?: Array<Record<string, any>> } } })?.where?.repo?.OR ?? [];
      const readable = or.some((c) => {
        const orgMember = c?.org?.memberships?.some;
        if (orgMember && orgMember.userId === "org-owner" && orgMember.role === "OWNER") return true;
        const teamMember = c?.teamAccess?.some?.team?.memberships?.some;
        if (teamMember && teamMember.userId === "team-reader") return true;
        return false;
      });
      return Promise.resolve(readable ? [{ createdAt: new Date("2026-05-01T10:00:00Z") }] : []);
    };
    vi.mocked(prisma.issue.findMany).mockImplementation(impl as never);
  }

  it("counts the author's own activity in a private org repo they OWN the org of (bug: was 0)", async () => {
    honorOrgVisibility();
    const owner = await authHeader(app, "org-owner");
    const res = await app.inject({
      method: "GET", url: "/users/alice/contributions", headers: { authorization: owner },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.days).toEqual([{ date: "2026-05-01", count: 1 }]);
  });

  it("counts the author's activity for a team member with READ access to the private org repo", async () => {
    honorOrgVisibility();
    const reader = await authHeader(app, "team-reader");
    const res = await app.inject({
      method: "GET", url: "/users/alice/contributions", headers: { authorization: reader },
    });
    expect(res.json().total).toBe(1);
  });

  it("still hides that private-org-repo activity from a non-member stranger", async () => {
    honorOrgVisibility();
    const stranger = await authHeader(app, "stranger");
    const res = await app.inject({
      method: "GET", url: "/users/alice/contributions", headers: { authorization: stranger },
    });
    expect(res.json().total).toBe(0);
  });

  it("still hides that private-org-repo activity from a guest", async () => {
    honorOrgVisibility();
    const res = await app.inject({ method: "GET", url: "/users/alice/contributions" });
    expect(res.json().total).toBe(0);
  });

  it("counts a PUBLIC org repo's activity for everyone (guest included)", async () => {
    // Model a PUBLIC repo: readable whenever the OR admits the public predicate,
    // which it always does — so a signed-out guest sees the author's activity.
    const impl = (args: unknown) => {
      const or =
        (args as { where?: { repo?: { OR?: Array<Record<string, any>> } } })?.where?.repo?.OR ?? [];
      const isPublic = or.some((c) => c?.visibility === "PUBLIC");
      return Promise.resolve(isPublic ? [{ createdAt: new Date("2026-05-02T10:00:00Z") }] : []);
    };
    vi.mocked(prisma.issue.findMany).mockImplementation(impl as never);
    const res = await app.inject({ method: "GET", url: "/users/alice/contributions" });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.days).toEqual([{ date: "2026-05-02", count: 1 }]);
  });
});
