import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    milestone: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    issue: { findMany: vi.fn() },
    pullRequest: { findMany: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { hashToken } from "../tokens.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-owner-ms";
const WRITER_ID = "user-writer-ms";
const READER_ID = "user-reader-ms";

function makeRepo(overrides = {}) {
  return {
    id: "repo-ms-1",
    name: "my-repo",
    description: null,
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    owner: { handle: "alice" },
    collaborators: [{ userId: WRITER_ID, role: "WRITER" }],
    ...overrides,
  };
}

function makeMilestone(overrides = {}) {
  return {
    id: "ms-1",
    repoId: "repo-ms-1",
    number: 1,
    title: "v1.0",
    description: "First release",
    dueOn: new Date("2026-09-01T00:00:00.000Z"),
    state: "OPEN" as const,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
  vi.mocked(prisma.milestone.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.milestone.count).mockResolvedValue(0 as never);
  // $transaction runs its callback against the same mock surface.
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) =>
    typeof fn === "function" ? (fn as (tx: typeof prisma) => unknown)(prisma) : fn) as never);
});

// ─── GET (list) + progress math ─────────────────────────────────────────────────

describe("GET /repos/:handle/:name/milestones", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  it("200 with empty list + zeroed counts", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/milestones" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ milestones: [], counts: { open: 0, closed: 0 } });
  });

  it("computes progress from associated issues + PRs (closed / total)", async () => {
    vi.mocked(prisma.milestone.findMany).mockResolvedValue([makeMilestone()] as never);
    // 2 issues (1 open, 1 closed) + 2 PRs (1 merged=closed, 1 open) → 2 of 4 closed = 50%.
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      { milestoneId: "ms-1", state: "OPEN" },
      { milestoneId: "ms-1", state: "CLOSED" },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { milestoneId: "ms-1", state: "MERGED" },
      { milestoneId: "ms-1", state: "OPEN" },
    ] as never);
    vi.mocked(prisma.milestone.count).mockResolvedValueOnce(1 as never).mockResolvedValueOnce(0 as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/milestones" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ open: 1, closed: 0 });
    expect(body.milestones).toHaveLength(1);
    expect(body.milestones[0]).toMatchObject({
      number: 1, title: "v1.0", state: "open",
      openItems: 2, closedItems: 2, totalItems: 4, percent: 50,
    });
  });

  it("percent is 0 for a milestone with no items", async () => {
    vi.mocked(prisma.milestone.findMany).mockResolvedValue([makeMilestone()] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/milestones" });
    expect(res.json().milestones[0]).toMatchObject({ totalItems: 0, percent: 0 });
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/nope/milestones" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST (create) + gating ─────────────────────────────────────────────────────

describe("POST /repos/:handle/:name/milestones", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let writerToken: string;
  let readerToken: string;
  beforeAll(async () => {
    app = await createTestServer();
    ownerToken = await authHeader(app, OWNER_ID);
    writerToken = await authHeader(app, WRITER_ID);
    readerToken = await authHeader(app, READER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.milestone.create).mockResolvedValue(makeMilestone() as never);
  });

  it("201 with the created milestone (writer)", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: writerToken },
      payload: { title: "v1.0", description: "First release", dueOn: "2026-09-01" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 1, title: "v1.0", state: "open", totalItems: 0, percent: 0 });
  });

  it("assigns number = max+1 in a transaction", async () => {
    vi.mocked(prisma.milestone.findFirst)
      .mockResolvedValueOnce(null) // dup-title check
      .mockResolvedValueOnce({ number: 4 } as never); // top-number lookup in tx
    vi.mocked(prisma.milestone.create).mockResolvedValue(makeMilestone({ number: 5 }) as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: ownerToken }, payload: { title: "v2.0" },
    });
    expect(res.statusCode).toBe(201);
    const createArg = vi.mocked(prisma.milestone.create).mock.calls[0][0] as { data: { number: number } };
    expect(createArg.data.number).toBe(5);
  });

  it("403 for a reader (write access required)", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: readerToken }, payload: { title: "v1.0" },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.milestone.create).not.toHaveBeenCalled();
  });

  it("401 for an anonymous request", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones", payload: { title: "v1.0" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 when title is missing", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: writerToken }, payload: { description: "no title" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when dueOn is not a valid date", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: writerToken }, payload: { title: "v1.0", dueOn: "not-a-date" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when the title already exists", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(makeMilestone() as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: writerToken }, payload: { title: "v1.0" },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ─── GET (detail) ───────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/milestones/:number", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  it("200 with progress for a single milestone", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(makeMilestone() as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([{ state: "CLOSED" }, { state: "OPEN" }, { state: "OPEN" }] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/milestones/1" });
    expect(res.statusCode).toBe(200);
    // 1 of 3 closed → 33%.
    expect(res.json()).toMatchObject({ number: 1, openItems: 2, closedItems: 1, totalItems: 3, percent: 33 });
  });

  it("404 when the milestone does not exist", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/milestones/99" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PATCH (update) + gating ────────────────────────────────────────────────────

describe("PATCH /repos/:handle/:name/milestones/:number", () => {
  let app: FastifyInstance;
  let writerToken: string;
  let readerToken: string;
  beforeAll(async () => {
    app = await createTestServer();
    writerToken = await authHeader(app, WRITER_ID);
    readerToken = await authHeader(app, READER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(makeMilestone() as never);
    vi.mocked(prisma.milestone.update).mockResolvedValue(makeMilestone({ state: "CLOSED", closedAt: new Date() }) as never);
  });

  it("200 closing a milestone sets closedAt", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/milestones/1",
      headers: { authorization: writerToken }, payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("closed");
    const updateArg = vi.mocked(prisma.milestone.update).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data.state).toBe("CLOSED");
    expect(updateArg.data.closedAt).toBeInstanceOf(Date);
  });

  it("403 for a reader", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/milestones/1",
      headers: { authorization: readerToken }, payload: { title: "renamed" },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.milestone.update).not.toHaveBeenCalled();
  });

  it("409 when renaming into an existing title", async () => {
    vi.mocked(prisma.milestone.findFirst)
      .mockResolvedValueOnce(makeMilestone() as never)       // the target milestone
      .mockResolvedValueOnce(makeMilestone({ id: "ms-2", number: 2, title: "taken" }) as never); // clash
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/milestones/1",
      headers: { authorization: writerToken }, payload: { title: "taken" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404 when the milestone does not exist", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/milestones/99",
      headers: { authorization: writerToken }, payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PAT scope enforcement (#87 wave-A D1) ──────────────────────────────────────
// A read-scoped PAT owned by a writer must be rejected at the scope preHandler,
// before the route's own canWrite check runs. A session JWT stays unscoped.

describe("POST /milestones — PAT scope enforcement", () => {
  const READ_PAT = "fhp_read_ms";
  let app: FastifyInstance;
  let writerSession: string;
  beforeAll(async () => {
    app = await createTestServer();
    writerSession = await authHeader(app, WRITER_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    // The token belongs to a writer, so only its scope — not repo access — blocks it.
    vi.mocked(prisma.personalAccessToken.findUnique).mockImplementation(((args: { where: { tokenHash: string } }) =>
      Promise.resolve(args.where.tokenHash === hashToken(READ_PAT)
        ? { id: "pat-1", userId: WRITER_ID, scopes: "repo:read", expiresAt: null }
        : null)) as never);
    vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.milestone.create).mockResolvedValue(makeMilestone() as never);
  });

  it("403s a repo:read PAT creating a milestone", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: `Bearer ${READ_PAT}` }, payload: { title: "v1.0" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
    expect(prisma.milestone.create).not.toHaveBeenCalled();
  });

  it("still lets a session JWT (unscoped) create a milestone", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/milestones",
      headers: { authorization: writerSession }, payload: { title: "v1.0" },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.milestone.create).toHaveBeenCalled();
  });
});

// ─── DELETE + gating ────────────────────────────────────────────────────────────

describe("DELETE /repos/:handle/:name/milestones/:number", () => {
  let app: FastifyInstance;
  let writerToken: string;
  let readerToken: string;
  beforeAll(async () => {
    app = await createTestServer();
    writerToken = await authHeader(app, WRITER_ID);
    readerToken = await authHeader(app, READER_ID);
  });
  afterAll(async () => { await app.close(); });

  it("204 when a writer deletes a milestone (associations SetNull, items kept)", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(makeMilestone() as never);
    vi.mocked(prisma.milestone.delete).mockResolvedValue(makeMilestone() as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/milestones/1",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.milestone.delete).toHaveBeenCalledWith({ where: { id: "ms-1" } });
  });

  it("403 for a reader", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(makeMilestone() as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/milestones/1",
      headers: { authorization: readerToken },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.milestone.delete).not.toHaveBeenCalled();
  });

  it("404 when the milestone does not exist", async () => {
    vi.mocked(prisma.milestone.findFirst).mockResolvedValue(null);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/milestones/99",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(404);
  });
});
