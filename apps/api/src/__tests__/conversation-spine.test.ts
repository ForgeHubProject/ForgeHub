import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
// NB: timeline-service and references-service are NOT mocked here — this suite
// exercises them for real against a mocked prisma.

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    repo: { findFirst: vi.fn(), findUnique: vi.fn() },
    issue: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    issueComment: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    issueLabel: { create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    label: { findFirst: vi.fn() },
    pullRequest: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    pullRequestComment: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    pullRequestReview: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestReviewComment: { findMany: vi.fn().mockResolvedValue([]) },
    protectedBranch: { findFirst: vi.fn().mockResolvedValue(null) },
    notification: { upsert: vi.fn(), findUnique: vi.fn() },
    crossReference: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    timelineEvent: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/my-repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
}));

vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn().mockResolvedValue(true),
  defaultBranch: vi.fn().mockResolvedValue("main"),
  resolveBranchSha: vi.fn().mockResolvedValue("abc1234"),
  performMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
  getMergeBaseDiff: vi.fn(), getMergeBaseFileList: vi.fn(), listMergeBaseCommits: vi.fn(),
}));

vi.mock("../merge/resolve-pull.js", () => ({
  resolvePullRequestMerge: vi.fn().mockResolvedValue({ ok: true, sha: "deadbeef" }),
}));

vi.mock("../ingest.js", () => ({ ingestCommitRange: vi.fn().mockResolvedValue(undefined) }));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { recordEvent, emitHeadPushedForPush } from "../timeline-service.js";
import { syncBodyReferences, closeIssuesForMergedPull } from "../references-service.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HANDLES: Record<string, string> = { "user-1": "alice", "user-2": "bob", "user-3": "carol" };
const NOW = new Date("2026-02-01T00:00:00.000Z");

const REPO = {
  id: "repo-1", name: "my-repo", visibility: "PUBLIC" as const,
  storageKey: "alice/my-repo.git", ownerId: "user-1", collaborators: [] as Array<{ userId: string; role: string }>,
};

function issueRow(o: Record<string, unknown> = {}) {
  return {
    id: "issue-1", number: 1, title: "Title", body: null, state: "OPEN",
    authorId: "user-1", assigneeId: null, closedAt: null, createdAt: NOW, updatedAt: NOW,
    author: { handle: "alice" }, assignee: null, labels: [], _count: { comments: 0 }, ...o,
  };
}

let app: FastifyInstance;
let aliceToken: string;

beforeAll(async () => {
  app = await createTestServer();
  aliceToken = await authHeader(app, "user-1");
});
afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(REPO as never);
  vi.mocked(prisma.user.findUnique).mockImplementation((args: unknown) => {
    const where = (args as { where: { id?: string; handle?: string } }).where;
    if (where.id) return Promise.resolve(HANDLES[where.id] ? { id: where.id, handle: HANDLES[where.id] } : null) as never;
    if (where.handle) {
      const id = Object.keys(HANDLES).find((k) => HANDLES[k] === where.handle);
      return Promise.resolve(id ? { id, handle: where.handle } : null) as never;
    }
    return Promise.resolve(null) as never;
  });
  vi.mocked(prisma.crossReference.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.timelineEvent.create).mockResolvedValue({} as never);
  vi.mocked(prisma.crossReference.create).mockResolvedValue({} as never);
  vi.mocked(prisma.notification.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.notification.findUnique).mockResolvedValue(null as never);
});

function lastCreate(kind?: string) {
  const calls = vi.mocked(prisma.timelineEvent.create).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
  return kind ? calls.find((d) => d.kind === kind) : calls.at(-1);
}

// ─── recordEvent ──────────────────────────────────────────────────────────────

describe("recordEvent", () => {
  it("denormalizes the actor handle into data and stores json", async () => {
    await recordEvent({ repoId: "repo-1", subjectType: "ISSUE", subjectNumber: 4, kind: "closed", actorId: "user-1" });
    const data = lastCreate() as { data: string; kind: string; subjectNumber: number };
    expect(data.kind).toBe("closed");
    expect(data.subjectNumber).toBe(4);
    expect(JSON.parse(data.data as unknown as string)).toEqual({ actorHandle: "alice" });
  });
});

// ─── emitHeadPushedForPush ──────────────────────────────────────────────────────

describe("emitHeadPushedForPush", () => {
  it("writes head_pushed on OPEN PRs whose head branch moved", async () => {
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([{ number: 7, fromBranch: "feature" }] as never);
    await emitHeadPushedForPush("repo-1", "user-2", [{ branch: "feature", oldSha: "aaa", newSha: "bbb" }]);
    const call = vi.mocked(prisma.timelineEvent.create).mock.calls.at(-1)![0] as { data: { kind: string; subjectNumber: number; data: string } };
    expect(call.data.kind).toBe("head_pushed");
    expect(call.data.subjectNumber).toBe(7);
    expect(JSON.parse(call.data.data)).toMatchObject({ actorHandle: "bob", branch: "feature", oldSha: "aaa", newSha: "bbb" });
  });

  it("no-ops when nothing changed", async () => {
    await emitHeadPushedForPush("repo-1", "user-2", []);
    expect(prisma.pullRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

// ─── syncBodyReferences ─────────────────────────────────────────────────────────

describe("syncBodyReferences", () => {
  it("creates a cross-reference and a referenced event for #N, and notifies @mentions", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-2", number: 2 } as never);
    await syncBodyReferences({
      repo: REPO, actorId: "user-1",
      source: { type: "ISSUE", id: "issue-1" },
      container: { subjectType: "ISSUE", id: "issue-1", number: 1, title: "Root" },
      body: "relates to #2, cc @bob",
    });

    const crossRef = vi.mocked(prisma.crossReference.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(crossRef.data).toMatchObject({ targetType: "ISSUE", targetNumber: 2, sourceType: "ISSUE", isClosingRef: false });

    const ref = lastCreate("referenced") as { data: string } | undefined;
    expect(ref).toBeTruthy();
    const refCall = vi.mocked(prisma.timelineEvent.create).mock.calls.find((c) => (c[0] as { data: { kind: string } }).data.kind === "referenced")![0] as { data: { subjectNumber: number; data: string } };
    expect(refCall.data.subjectNumber).toBe(2);
    expect(JSON.parse(refCall.data.data)).toMatchObject({ sourceType: "ISSUE", sourceNumber: 1, sourceTitle: "Root" });

    expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
    const notif = vi.mocked(prisma.notification.upsert).mock.calls[0][0] as { create: { userId: string; reason: string } };
    expect(notif.create).toMatchObject({ userId: "user-2", reason: "MENTIONED" });
  });

  it("marks closing keywords as closing refs", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-9", number: 9 } as never);
    await syncBodyReferences({
      repo: REPO, actorId: "user-1",
      source: { type: "PULL_REQUEST", id: "pr-1" },
      container: { subjectType: "PULL_REQUEST", id: "pr-1", number: 3, title: "PR" },
      body: "closes #9",
    });
    const crossRef = vi.mocked(prisma.crossReference.create).mock.calls[0][0] as { data: { isClosingRef: boolean } };
    expect(crossRef.data.isClosingRef).toBe(true);
  });

  it("does not notify the actor for a self-mention", async () => {
    await syncBodyReferences({
      repo: REPO, actorId: "user-1",
      source: { type: "ISSUE", id: "issue-1" },
      container: { subjectType: "ISSUE", id: "issue-1", number: 1, title: "Root" },
      body: "note to self @alice",
    });
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });

  it("does not parse references inside code spans", async () => {
    await syncBodyReferences({
      repo: REPO, actorId: "user-1",
      source: { type: "ISSUE", id: "issue-1" },
      container: { subjectType: "ISSUE", id: "issue-1", number: 1, title: "Root" },
      body: "literal `#2` and `@bob`",
    });
    expect(prisma.issue.findFirst).not.toHaveBeenCalled();
    expect(prisma.crossReference.create).not.toHaveBeenCalled();
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });

  it("drops references removed on edit (diff against existing rows)", async () => {
    vi.mocked(prisma.crossReference.findMany).mockResolvedValue([
      { id: "xref-old", sourceType: "ISSUE", sourceId: "issue-1", targetType: "ISSUE", targetId: "issue-2", targetNumber: 2, isClosingRef: false },
    ] as never);
    await syncBodyReferences({
      repo: REPO, actorId: "user-1",
      source: { type: "ISSUE", id: "issue-1" },
      container: { subjectType: "ISSUE", id: "issue-1", number: 1, title: "Root" },
      body: "no references anymore",
    });
    expect(prisma.crossReference.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["xref-old"] } } });
    expect(prisma.crossReference.create).not.toHaveBeenCalled();
  });
});

// ─── closeIssuesForMergedPull ────────────────────────────────────────────────────

describe("closeIssuesForMergedPull", () => {
  it("closes OPEN issues referenced by closing keywords and records a closed event", async () => {
    vi.mocked(prisma.crossReference.findMany).mockResolvedValue([
      { id: "x1", targetId: "issue-2", targetNumber: 2, isClosingRef: true, targetType: "ISSUE" },
    ] as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-2", state: "OPEN" } as never);
    vi.mocked(prisma.issue.update).mockResolvedValue({} as never);

    await closeIssuesForMergedPull({ repoId: "repo-1", prId: "pr-1", prNumber: 3, mergerId: "user-3" });

    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "issue-2" }, data: expect.objectContaining({ state: "CLOSED" }),
    }));
    const closed = lastCreate("closed") as { data: string };
    expect(closed).toBeTruthy();
    expect(JSON.parse(closed.data)).toMatchObject({ actorHandle: "carol", closedByPull: 3 });
  });

  it("leaves already-closed issues untouched", async () => {
    vi.mocked(prisma.crossReference.findMany).mockResolvedValue([
      { id: "x1", targetId: "issue-2", targetNumber: 2, isClosingRef: true, targetType: "ISSUE" },
    ] as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-2", state: "CLOSED" } as never);
    await closeIssuesForMergedPull({ repoId: "repo-1", prId: "pr-1", prNumber: 3, mergerId: "user-3" });
    expect(prisma.issue.update).not.toHaveBeenCalled();
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

// ─── Route wiring: mutation sites write events ────────────────────────────────────

describe("route wiring", () => {
  it("POST issue labels writes a `labeled` event", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(issueRow() as never);
    vi.mocked(prisma.label.findFirst).mockResolvedValue({ id: "label-1", name: "bug", color: "#c00", repoId: "repo-1" } as never);
    vi.mocked(prisma.issueLabel.create).mockResolvedValue({} as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/issues/1/labels",
      headers: { authorization: aliceToken }, payload: { labelId: "label-1" },
    });
    expect(res.statusCode).toBe(201);
    const labeled = lastCreate("labeled") as { data: string };
    expect(labeled).toBeTruthy();
    expect(JSON.parse(labeled.data)).toMatchObject({ actorHandle: "alice", label: { name: "bug", color: "#c00" } });
  });

  it("PATCH issue to closed writes a `closed` event", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(issueRow({ state: "OPEN" }) as never);
    vi.mocked(prisma.issue.update).mockResolvedValue(issueRow({ state: "CLOSED", closedAt: NOW }) as never);

    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: aliceToken }, payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    expect(lastCreate("closed")).toBeTruthy();
  });

  it("PATCH issue title writes a `title_changed` event", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(issueRow({ title: "Old" }) as never);
    vi.mocked(prisma.issue.update).mockResolvedValue(issueRow({ title: "New" }) as never);

    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/issues/1",
      headers: { authorization: aliceToken }, payload: { title: "New" },
    });
    expect(res.statusCode).toBe(200);
    const evt = lastCreate("title_changed") as { data: string };
    expect(JSON.parse(evt.data)).toMatchObject({ from: "Old", to: "New" });
  });

  it("merging a PR writes a `merged` event and closes referenced issues", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue({ id: "pr-1", number: 3, state: "OPEN", fromBranch: "feat", toBranch: "main" } as never);
    vi.mocked(prisma.pullRequest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.crossReference.findMany).mockResolvedValue([
      { id: "x1", targetId: "issue-2", targetNumber: 2, isClosingRef: true, targetType: "ISSUE" },
    ] as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-2", state: "OPEN" } as never);
    vi.mocked(prisma.issue.update).mockResolvedValue({} as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/pulls/3/merge",
      headers: { authorization: aliceToken }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(lastCreate("merged")).toBeTruthy();
    expect(lastCreate("closed")).toBeTruthy();
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "CLOSED" }) }));
  });

  it("GET issue timeline returns formatted events", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-1" } as never);
    vi.mocked(prisma.timelineEvent.findMany).mockResolvedValue([
      { id: "e1", kind: "closed", actorId: "user-1", data: JSON.stringify({ actorHandle: "alice", closedByPull: 3 }), createdAt: NOW },
    ] as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/issues/1/timeline" });
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "closed", actor: "alice", data: { closedByPull: 3 } });
  });
});
