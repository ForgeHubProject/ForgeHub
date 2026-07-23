import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    repo: { findFirst: vi.fn() },
    label: { findMany: vi.fn() },
    issue: { findFirst: vi.fn(), update: vi.fn() },
    issueComment: { create: vi.fn() },
    issueLabel: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    milestone: { findMany: vi.fn() },
    pullRequest: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../timeline-service.js", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
  emitHeadPushedForPush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notifications-service.js", () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../references-service.js", () => ({
  syncBodyReferences: vi.fn().mockResolvedValue(undefined),
  closeIssuesForMergedPull: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("alice/my-repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

vi.mock("../git-utils.js", () => ({
  branchExists: vi.fn().mockResolvedValue(true),
  defaultBranch: vi.fn().mockResolvedValue("main"),
  resolveBranchSha: vi.fn().mockResolvedValue("abc1234"),
  performMerge: vi.fn(),
  listMergeBaseCommits: vi.fn().mockResolvedValue([]),
  getMergeBaseFileList: vi.fn().mockResolvedValue([]),
  getMergeBaseDiff: vi.fn().mockResolvedValue([]),
  performSquashMerge: vi.fn(),
  performRebaseMerge: vi.fn(),
  performRevert: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$hashed$"), compare: vi.fn().mockResolvedValue(true) },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { recordEvent } from "../timeline-service.js";
import {
  parseQuickActions, parseLabelTokens, parseMilestoneTitle, applyQuickActions,
  type QuickActionSubject,
} from "../quick-actions.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-owner-qa";
const AUTHOR_ID = "user-author-qa";
const READER_ID = "user-reader-qa";
const WRITER_ID = "user-writer-qa";

const repo = {
  id: "repo-qa",
  ownerId: OWNER_ID,
  collaborators: [{ userId: WRITER_ID, role: "WRITER" }],
};

type IssueFields = Extract<QuickActionSubject, { type: "ISSUE" }>["issue"];
type PrFields = Extract<QuickActionSubject, { type: "PULL_REQUEST" }>["pr"];

function issueSubject(overrides: Partial<IssueFields> = {}): QuickActionSubject {
  return {
    type: "ISSUE",
    issue: {
      id: "issue-qa", number: 7, authorId: AUTHOR_ID, state: "OPEN",
      title: "Original title", assigneeId: null, estimateMinutes: 0, spentMinutes: 0,
      milestoneId: null,
      ...overrides,
    },
  };
}

function prSubject(overrides: Partial<PrFields> = {}): QuickActionSubject {
  return {
    type: "PULL_REQUEST",
    pr: { id: "pr-qa", number: 3, authorId: AUTHOR_ID, state: "OPEN", ...overrides },
  };
}

// Extract the `data` payloads passed to a strictly-typed prisma update mock,
// as plain records — so assertions don't wrestle with Prisma's union input types.
const issueUpdates = () =>
  vi.mocked(prisma.issue.update).mock.calls.map((c) => (c[0] as unknown as { data: Record<string, unknown> }).data);
const prUpdates = () =>
  vi.mocked(prisma.pullRequest.update).mock.calls.map((c) => (c[0] as unknown as { data: Record<string, unknown> }).data);

const bugLabel = { id: "label-bug", name: "bug", color: "d73a4a" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.label.findMany).mockResolvedValue([bugLabel] as never);
  vi.mocked(prisma.issueLabel.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.issueLabel.create).mockResolvedValue({} as never);
  vi.mocked(prisma.issueLabel.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.issue.update).mockResolvedValue({} as never);
  vi.mocked(prisma.pullRequest.update).mockResolvedValue({} as never);
  vi.mocked(prisma.user.findUnique).mockImplementation(((args: { where: { id?: string; handle?: string } }) => {
    const where = args.where;
    if (where.handle === "alice") return Promise.resolve({ id: "u-alice", handle: "alice" });
    if (where.handle) return Promise.resolve(null);
    // id lookups (handleOf)
    const handles: Record<string, string> = {
      [OWNER_ID]: "owner", [AUTHOR_ID]: "author", [WRITER_ID]: "writer", "u-alice": "alice",
    };
    return Promise.resolve({ handle: handles[where.id ?? ""] ?? "ghost" });
  }) as never);
});

// ─── Parser: parseQuickActions ──────────────────────────────────────────────────

describe("parseQuickActions", () => {
  it("extracts a single command and keeps the prose", () => {
    const r = parseQuickActions("/close\nThanks, fixed it.");
    expect(r.commands).toEqual([{ name: "close", arg: "", raw: "/close" }]);
    expect(r.body).toBe("Thanks, fixed it.");
  });

  it("extracts multiple commands, in order, interleaved with prose", () => {
    const r = parseQuickActions("hello\n/label bug\nmiddle\n/assign @alice\nbye");
    expect(r.commands.map((c) => c.name)).toEqual(["label", "assign"]);
    expect(r.commands[0].arg).toBe("bug");
    expect(r.commands[1].arg).toBe("@alice");
    expect(r.body).toBe("hello\nmiddle\nbye");
  });

  it("returns an empty body for a command-only comment", () => {
    const r = parseQuickActions("/close\n/label bug");
    expect(r.commands).toHaveLength(2);
    expect(r.body).toBe("");
  });

  it("captures unknown commands too (so they can be reported back)", () => {
    const r = parseQuickActions("/frobnicate everything");
    expect(r.commands).toEqual([{ name: "frobnicate", arg: "everything", raw: "/frobnicate everything" }]);
    expect(r.body).toBe("");
  });

  it("lower-cases the command name and trims the arg", () => {
    const r = parseQuickActions("/ESTIMATE   2h30m  ");
    expect(r.commands[0]).toEqual({ name: "estimate", arg: "2h30m", raw: "/ESTIMATE   2h30m" });
  });

  it("ignores slash lines inside fenced code blocks", () => {
    const r = parseQuickActions("```\n/close\n```\n/reopen");
    expect(r.commands.map((c) => c.name)).toEqual(["reopen"]);
    expect(r.body).toBe("```\n/close\n```");
  });

  it("keeps a /title's full remainder as its arg", () => {
    const r = parseQuickActions("/title New shiny title here");
    expect(r.commands[0]).toEqual({ name: "title", arg: "New shiny title here", raw: "/title New shiny title here" });
  });

  it("handles empty / null input", () => {
    expect(parseQuickActions("").commands).toEqual([]);
    expect(parseQuickActions(null).body).toBe("");
  });
});

describe("parseLabelTokens", () => {
  it("splits sigils, quotes and plain names", () => {
    expect(parseLabelTokens('~bug ~"help wanted" \'needs triage\' feature')).toEqual([
      "bug", "help wanted", "needs triage", "feature",
    ]);
  });
  it("returns [] for empty args", () => {
    expect(parseLabelTokens("")).toEqual([]);
  });
});

describe("parseMilestoneTitle", () => {
  it("keeps a bare multi-word title", () => {
    expect(parseMilestoneTitle("Sprint 4")).toBe("Sprint 4");
  });
  it("strips the % sigil", () => {
    expect(parseMilestoneTitle("%Backlog")).toBe("Backlog");
  });
  it("strips %\"quoted\" titles", () => {
    expect(parseMilestoneTitle('%"v1.0 beta"')).toBe("v1.0 beta");
  });
  it("strips 'single-quoted' titles", () => {
    expect(parseMilestoneTitle("'Sprint 4'")).toBe("Sprint 4");
  });
  it("returns '' for an empty arg", () => {
    expect(parseMilestoneTitle("")).toBe("");
  });
});

// ─── Applier: permissions ───────────────────────────────────────────────────────

describe("applyQuickActions — permissions", () => {
  it("rejects label changes from a non-writer, non-author", async () => {
    const { commands } = parseQuickActions("/label bug");
    const res = await applyQuickActions({ repo, actorId: READER_ID, commands, subject: issueSubject() });
    expect(res.applied).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ command: "/label" });
    expect(res.rejected[0].reason).toMatch(/write access/i);
    expect(prisma.issueLabel.create).not.toHaveBeenCalled();
  });

  it("rejects /close from a non-writer, non-author", async () => {
    const { commands } = parseQuickActions("/close");
    const res = await applyQuickActions({ repo, actorId: READER_ID, commands, subject: issueSubject() });
    expect(res.rejected[0].command).toBe("/close");
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it("allows the issue author to /close even without write access", async () => {
    const { commands } = parseQuickActions("/close");
    const res = await applyQuickActions({ repo, actorId: AUTHOR_ID, commands, subject: issueSubject() });
    expect(res.applied[0].command).toBe("/close");
    expect(issueUpdates()).toEqual(expect.arrayContaining([expect.objectContaining({ state: "CLOSED" })]));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "closed" }));
  });
});

// ─── Applier: /label + /assign end-to-end, timeline events fire ─────────────────

describe("applyQuickActions — /label + /assign emit timeline events", () => {
  it("adds the label and assignee and records both events", async () => {
    const { commands } = parseQuickActions("/label bug\n/assign @alice");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });

    expect(res.applied.map((a) => a.command)).toEqual(["/label", "/assign"]);
    expect(prisma.issueLabel.create).toHaveBeenCalledWith({ data: { issueId: "issue-qa", labelId: "label-bug" } });
    expect(issueUpdates()).toContainEqual({ assigneeId: "u-alice" });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "labeled", data: { label: { name: "bug", color: "d73a4a" } } }),
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "assigned", data: { assignee: "alice" } }),
    );
  });

  it("assigns the actor for `/assign me`", async () => {
    const { commands } = parseQuickActions("/assign me");
    const res = await applyQuickActions({ repo, actorId: WRITER_ID, commands, subject: issueSubject() });
    expect(res.applied[0].summary).toMatch(/@writer/);
    expect(issueUpdates()).toContainEqual({ assigneeId: WRITER_ID });
  });

  it("rejects an unknown user and does not mutate", async () => {
    const { commands } = parseQuickActions("/assign @ghosthandle");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });
    expect(res.rejected[0].reason).toMatch(/no user/i);
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it("rejects a label that does not exist in the repo", async () => {
    const { commands } = parseQuickActions("/label nonexistent");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });
    expect(res.rejected[0].reason).toMatch(/does not exist/i);
  });

  it("reports unknown commands", async () => {
    const { commands } = parseQuickActions("/frobnicate");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });
    expect(res.rejected[0]).toMatchObject({ command: "/frobnicate" });
    expect(res.rejected[0].reason).toMatch(/unknown/i);
  });
});

// ─── Applier: time tracking accumulation ────────────────────────────────────────

describe("applyQuickActions — estimate & spend", () => {
  it("sets an absolute estimate and accumulates spend across a comment", async () => {
    const { commands } = parseQuickActions("/estimate 2d\n/spend 3h\n/spend 30m");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });

    expect(res.applied).toHaveLength(3);
    const updates = issueUpdates();
    // 2d = 960m estimate, spend 180 then +30 → 210
    expect(updates).toContainEqual({ estimateMinutes: 960 });
    expect(updates).toContainEqual({ spentMinutes: 180 });
    expect(updates).toContainEqual({ spentMinutes: 210 });
  });

  it("subtracts on negative /spend and floors at zero", async () => {
    const { commands } = parseQuickActions("/spend -2h");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject({ spentMinutes: 30 }) });
    expect(res.applied[0].summary).toMatch(/subtracted/i);
    expect(issueUpdates()).toContainEqual({ spentMinutes: 0 });
  });

  it("rejects an invalid duration", async () => {
    const { commands } = parseQuickActions("/estimate soon");
    const res = await applyQuickActions({ repo, actorId: OWNER_ID, commands, subject: issueSubject() });
    expect(res.rejected[0].reason).toMatch(/not a valid duration/i);
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it("clears with /remove_estimate and /remove_time_spent", async () => {
    const { commands } = parseQuickActions("/remove_estimate\n/remove_time_spent");
    const res = await applyQuickActions({
      repo, actorId: OWNER_ID, commands,
      subject: issueSubject({ estimateMinutes: 120, spentMinutes: 45 }),
    });
    expect(res.applied).toHaveLength(2);
    expect(issueUpdates()).toContainEqual({ estimateMinutes: 0 });
    expect(issueUpdates()).toContainEqual({ spentMinutes: 0 });
  });
});

// ─── Applier: pull requests ─────────────────────────────────────────────────────

describe("applyQuickActions — pull requests", () => {
  it("closes an open PR for its author and records the event", async () => {
    const { commands } = parseQuickActions("/close");
    const res = await applyQuickActions({ repo, actorId: AUTHOR_ID, commands, subject: prSubject() });
    expect(res.applied[0].summary).toMatch(/closed this pull request/i);
    expect(prUpdates()).toContainEqual({ state: "CLOSED" });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "closed", subjectType: "PULL_REQUEST" }));
  });

  it("rejects issue-only commands on a PR", async () => {
    const { commands } = parseQuickActions("/label bug\n/estimate 2h");
    const res = await applyQuickActions({ repo, actorId: AUTHOR_ID, commands, subject: prSubject() });
    expect(res.rejected.map((r) => r.command)).toEqual(["/label", "/estimate"]);
    expect(res.rejected.every((r) => /not available on pull requests/i.test(r.reason))).toBe(true);
  });

  it("refuses to change the state of a merged PR", async () => {
    const { commands } = parseQuickActions("/reopen");
    const res = await applyQuickActions({ repo, actorId: AUTHOR_ID, commands, subject: prSubject({ state: "MERGED" }) });
    expect(res.rejected[0].reason).toMatch(/merged/i);
  });
});

// ─── Applier: /milestone + /remove_milestone (#83) ──────────────────────────────

describe("applyQuickActions — /milestone", () => {
  const v1 = { id: "ms-v1", number: 3, title: "v1.0" };

  beforeEach(() => {
    vi.mocked(prisma.milestone.findMany).mockResolvedValue([v1] as never);
  });

  it("sets the milestone by title and records a milestoned event (writer)", async () => {
    const { commands } = parseQuickActions('/milestone "v1.0"');
    const res = await applyQuickActions({ repo, actorId: WRITER_ID, commands, subject: issueSubject() });
    expect(res.applied[0]).toMatchObject({ command: "/milestone" });
    expect(res.applied[0].summary).toMatch(/v1\.0/);
    expect(issueUpdates()).toContainEqual({ milestoneId: "ms-v1" });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "milestoned", data: { milestone: { title: "v1.0", number: 3 } } }),
    );
  });

  it("rejects an unknown milestone title and does not mutate", async () => {
    const { commands } = parseQuickActions("/milestone Ghost");
    const res = await applyQuickActions({ repo, actorId: WRITER_ID, commands, subject: issueSubject() });
    expect(res.applied).toHaveLength(0);
    expect(res.rejected[0].command).toBe("/milestone");
    expect(res.rejected[0].reason).toMatch(/does not exist/i);
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it("rejects /milestone from a non-writer author", async () => {
    const { commands } = parseQuickActions("/milestone v1.0");
    const res = await applyQuickActions({ repo, actorId: AUTHOR_ID, commands, subject: issueSubject() });
    expect(res.rejected[0].reason).toMatch(/write access/i);
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it("/remove_milestone clears it and records a demilestoned event", async () => {
    const { commands } = parseQuickActions("/remove_milestone");
    const res = await applyQuickActions({
      repo, actorId: WRITER_ID, commands, subject: issueSubject({ milestoneId: "ms-v1" }),
    });
    expect(res.applied[0].command).toBe("/remove_milestone");
    expect(issueUpdates()).toContainEqual({ milestoneId: null });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "demilestoned", data: { milestone: { title: "v1.0", number: 3 } } }),
    );
  });

  it("/remove_milestone on an issue with no milestone is a no-op success", async () => {
    const { commands } = parseQuickActions("/remove_milestone");
    const res = await applyQuickActions({ repo, actorId: WRITER_ID, commands, subject: issueSubject() });
    expect(res.applied[0].summary).toMatch(/not on a milestone/i);
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });
});

// ─── Route integration: POST issue comment strips commands + returns summary ────

describe("POST issue comment with quick actions", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
  });
  afterAll(async () => { await app.close(); });

  const makeRepoRow = () => ({
    id: "repo-qa", name: "my-repo", visibility: "PUBLIC", storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID, owner: { handle: "alice" }, collaborators: [{ userId: WRITER_ID, role: "WRITER" }],
  });
  const makeIssueRow = (o = {}) => ({
    id: "issue-qa", repoId: "repo-qa", number: 1, title: "Original title", body: "b",
    state: "OPEN", authorId: AUTHOR_ID, assigneeId: null, estimateMinutes: 0, spentMinutes: 0,
    closedAt: null, createdAt: new Date(), updatedAt: new Date(), ...o,
  });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepoRow() as never);
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(makeIssueRow() as never);
    vi.mocked(prisma.issueComment.create).mockResolvedValue({
      id: "c-1", body: "Looks good", author: { handle: "owner" }, createdAt: new Date(), updatedAt: new Date(),
    } as never);
  });

  it("strips command lines, stores the prose, applies actions and returns a summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues/1/comments",
      headers: { authorization: ownerToken },
      payload: { body: "/assign me\n/label bug\nLooks good" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Prose stored without command lines
    const createArg = vi.mocked(prisma.issueComment.create).mock.calls[0][0] as unknown as { data: { body: string } };
    expect(createArg.data.body).toBe("Looks good");
    expect(body.comment.body).toBe("Looks good");
    expect(body.body).toBe("Looks good"); // back-compat top-level fields
    // Applied summary the UI can toast
    expect(body.actions.applied.map((a: { command: string }) => a.command)).toEqual(["/assign", "/label"]);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "assigned" }));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "labeled" }));
  });

  it("creates no comment for a command-only body but still applies actions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues/1/comments",
      headers: { authorization: ownerToken },
      payload: { body: "/close" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.comment).toBeNull();
    expect(prisma.issueComment.create).not.toHaveBeenCalled();
    expect(body.actions.applied[0].command).toBe("/close");
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "closed" }));
  });

  it("400 when the body is empty and has no commands", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/issues/1/comments",
      headers: { authorization: ownerToken },
      payload: { body: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});
