import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    project: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectColumn: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectItem: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    issue: { findFirst: vi.fn(), findMany: vi.fn() },
    pullRequest: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// git-storage is imported transitively via server wiring; stub to avoid fs calls.
vi.mock("../git-storage.js", () => ({
  buildStorageKey: vi.fn().mockReturnValue("user/repo.git"),
  createBareRepo: vi.fn().mockResolvedValue("/tmp/repo"),
  removeBareRepo: vi.fn().mockResolvedValue(undefined),
  moveBareRepo: vi.fn().mockResolvedValue(undefined),
  bareRepoPathFromKey: vi.fn().mockReturnValue("/tmp/repo"),
  inspectBareRepo: vi.fn(),
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = "user-owner";
const WRITER_ID = "user-writer";
const READER_ID = "user-reader";

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    name: "my-repo",
    ownerId: OWNER_ID,
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    collaborators: [
      { userId: WRITER_ID, role: "WRITER" },
      { userId: READER_ID, role: "READER" },
    ],
    ...overrides,
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    repoId: "repo-1",
    number: 1,
    name: "Roadmap",
    description: "Q3 plan",
    closed: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

function txPassthrough() {
  vi.mocked(prisma.$transaction).mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma as never);
    return Promise.all(arg as Promise<unknown>[]);
  });
}

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
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
  txPassthrough();
});

// ─── Project list ─────────────────────────────────────────────────────────────

describe("GET /repos/:handle/:name/projects", () => {
  it("200 with open projects for a public repo (no auth)", async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      { ...makeProject(), _count: { items: 4, columns: 3 } },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ number: 1, name: "Roadmap", itemCount: 4, columnCount: 3, closed: false });
  });

  it("filters by state=closed", async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([] as never);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects?state=closed" });
    expect(vi.mocked(prisma.project.findMany).mock.calls[0]![0]).toMatchObject({
      where: { repoId: "repo-1", closed: true },
    });
  });

  it("state=all applies no closed filter", async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([] as never);
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects?state=all" });
    const where = vi.mocked(prisma.project.findMany).mock.calls[0]![0]!.where as Record<string, unknown>;
    expect(where).not.toHaveProperty("closed");
  });

  it("404 for a private repo the viewer cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE", collaborators: [] }) as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Project create ─────────────────────────────────────────────────────────────

describe("POST /repos/:handle/:name/projects", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.project.create).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.projectColumn.createMany).mockResolvedValue({ count: 3 } as never);
    // loadDetail after create: 3 seeded columns, no items.
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValue([
      { id: "col-1", name: "Todo", position: 0 },
      { id: "col-2", name: "In progress", position: 1 },
      { id: "col-3", name: "Done", position: 2 },
    ] as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([] as never);
  });

  it("401 when unauthenticated", async () => {
    const res = await app.inject({ method: "POST", url: "/repos/alice/my-repo/projects", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a reader", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/projects",
      headers: { authorization: readerToken },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400 when name is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/projects",
      headers: { authorization: writerToken },
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("201 and seeds Todo / In progress / Done as columns 0,1,2", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/projects",
      headers: { authorization: writerToken },
      payload: { name: "Roadmap", description: "Q3 plan" },
    });
    expect(res.statusCode).toBe(201);
    const seeded = vi.mocked(prisma.projectColumn.createMany).mock.calls[0]![0]!.data as Array<{ name: string; position: number }>;
    expect(seeded).toEqual([
      { projectId: "proj-1", name: "Todo", position: 0 },
      { projectId: "proj-1", name: "In progress", position: 1 },
      { projectId: "proj-1", name: "Done", position: 2 },
    ]);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(["Todo", "In progress", "Done"]);
  });

  it("assigns number = count + 1", async () => {
    vi.mocked(prisma.project.count).mockResolvedValue(4 as never);
    vi.mocked(prisma.project.create).mockResolvedValue(makeProject({ number: 5 }) as never);
    await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/projects",
      headers: { authorization: writerToken },
      payload: { name: "Fifth" },
    });
    expect(vi.mocked(prisma.project.create).mock.calls[0]![0]!.data).toMatchObject({ number: 5 });
  });
});

// ─── Project detail (hydration) ─────────────────────────────────────────────────

describe("GET /repos/:handle/:name/projects/:number", () => {
  it("404 when the project does not exist", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects/9" });
    expect(res.statusCode).toBe(404);
  });

  it("hydrates an issue item (labels + assignee) and a PR item", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValue([
      { id: "col-1", name: "Todo", position: 0 },
    ] as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([
      { id: "i1", columnId: "col-1", position: 0, subjectType: "ISSUE", subjectNumber: 5, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "i2", columnId: "col-1", position: 1, subjectType: "PULL_REQUEST", subjectNumber: 7, createdAt: new Date("2026-01-01T00:00:00Z") },
    ] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      {
        number: 5,
        title: "Broken thing",
        state: "OPEN",
        assignee: { handle: "bob" },
        labels: [{ label: { id: "L1", name: "bug", color: "c0392b" } }],
      },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([
      { number: 7, title: "Add feature", state: "MERGED" },
    ] as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects/1" });
    expect(res.statusCode).toBe(200);
    const col = res.json().columns[0];
    expect(col.items[0].subject).toMatchObject({
      type: "issue", number: 5, title: "Broken thing", state: "open", assignee: "bob",
      labels: [{ id: "L1", name: "bug", color: "c0392b" }],
    });
    expect(col.items[1].subject).toMatchObject({
      type: "pull", number: 7, state: "merged", assignee: null, labels: [],
    });
  });

  it("returns subject: null for an item whose issue was deleted (graceful)", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValue([{ id: "col-1", name: "Todo", position: 0 }] as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([
      { id: "i1", columnId: "col-1", position: 0, subjectType: "ISSUE", subjectNumber: 99, createdAt: new Date() },
    ] as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/projects/1" });
    expect(res.json().columns[0].items[0].subject).toBeNull();
  });
});

// ─── Project update / delete ────────────────────────────────────────────────────

describe("PATCH /repos/:handle/:name/projects/:number", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.project.update).mockResolvedValue(makeProject({ closed: true }) as never);
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([] as never);
  });

  it("403 for a reader", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1",
      headers: { authorization: readerToken }, payload: { closed: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("toggles closed for a writer", async () => {
    // findFirst called twice: initial lookup + reload after update.
    vi.mocked(prisma.project.findFirst)
      .mockResolvedValueOnce(makeProject() as never)
      .mockResolvedValueOnce(makeProject({ closed: true }) as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1",
      headers: { authorization: writerToken }, payload: { closed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.project.update).mock.calls[0]![0]!.data).toMatchObject({ closed: true });
    expect(res.json().closed).toBe(true);
  });
});

describe("DELETE /repos/:handle/:name/projects/:number", () => {
  it("204 for the owner", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.project.delete).mockResolvedValue(makeProject() as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.project.delete)).toHaveBeenCalledWith({ where: { id: "proj-1" } });
  });

  it("403 for a reader", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1",
      headers: { authorization: readerToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Columns ────────────────────────────────────────────────────────────────────

describe("columns", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
  });

  it("creates a column appended at the end", async () => {
    vi.mocked(prisma.projectColumn.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.projectColumn.create).mockResolvedValue({ id: "col-4", name: "Backlog", position: 3 } as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/columns",
      headers: { authorization: writerToken }, payload: { name: "Backlog" },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.projectColumn.create).mock.calls[0]![0]!.data).toMatchObject({ position: 3, name: "Backlog" });
  });

  it("renames a column", async () => {
    vi.mocked(prisma.projectColumn.findFirst).mockResolvedValue({ id: "col-1", name: "Todo", position: 0 } as never);
    vi.mocked(prisma.projectColumn.update).mockResolvedValue({ id: "col-1", name: "To do", position: 0 } as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/columns/col-1",
      headers: { authorization: writerToken }, payload: { name: "To do" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("To do");
  });

  it("reorders columns by permutation and sets dense positions", async () => {
    vi.mocked(prisma.projectColumn.findMany)
      .mockResolvedValueOnce([{ id: "col-1" }, { id: "col-2" }, { id: "col-3" }] as never)
      .mockResolvedValueOnce([
        { id: "col-3", name: "Done", position: 0 },
        { id: "col-1", name: "Todo", position: 1 },
        { id: "col-2", name: "In progress", position: 2 },
      ] as never);
    vi.mocked(prisma.projectColumn.update).mockResolvedValue({} as never);
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/projects/1/columns/order",
      headers: { authorization: writerToken }, payload: { order: ["col-3", "col-1", "col-2"] },
    });
    expect(res.statusCode).toBe(200);
    const calls = vi.mocked(prisma.projectColumn.update).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { where: { id: "col-3" }, data: { position: 0 } },
      { where: { id: "col-1" }, data: { position: 1 } },
      { where: { id: "col-2" }, data: { position: 2 } },
    ]);
  });

  it("400 when the reorder is not a permutation of the project's columns", async () => {
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValueOnce([{ id: "col-1" }, { id: "col-2" }, { id: "col-3" }] as never);
    const res = await app.inject({
      method: "PUT", url: "/repos/alice/my-repo/projects/1/columns/order",
      headers: { authorization: writerToken }, payload: { order: ["col-1", "col-2"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when deleting a column that still has cards", async () => {
    vi.mocked(prisma.projectColumn.findFirst).mockResolvedValue({ id: "col-1", name: "Todo", position: 0 } as never);
    vi.mocked(prisma.projectItem.count).mockResolvedValue(2 as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1/columns/col-1",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it("204 deleting an empty column, renumbering the rest", async () => {
    vi.mocked(prisma.projectColumn.findFirst).mockResolvedValue({ id: "col-2", name: "In progress", position: 1 } as never);
    vi.mocked(prisma.projectItem.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.projectColumn.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.projectColumn.findMany).mockResolvedValue([
      { id: "col-1", position: 0 },
      { id: "col-3", position: 2 },
    ] as never);
    vi.mocked(prisma.projectColumn.update).mockResolvedValue({} as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1/columns/col-2",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(204);
    // col-3 was at 2, should be renumbered to 1.
    expect(vi.mocked(prisma.projectColumn.update)).toHaveBeenCalledWith({ where: { id: "col-3" }, data: { position: 1 } });
  });
});

// ─── Item add ───────────────────────────────────────────────────────────────────

describe("POST .../items (add)", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.projectColumn.findFirst).mockResolvedValue({ id: "col-1", name: "Todo", position: 0 } as never);
  });

  it("adds an issue at the end of its column", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-5" } as never);
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(null as never); // no dup
    vi.mocked(prisma.projectItem.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.projectItem.create).mockResolvedValue({
      id: "item-x", columnId: "col-1", position: 2, subjectType: "ISSUE", subjectNumber: 5, createdAt: new Date(),
    } as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([
      { number: 5, title: "Bug", state: "OPEN", assignee: null, labels: [] },
    ] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([] as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: writerToken }, payload: { columnId: "col-1", type: "issue", number: 5 },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.projectItem.create).mock.calls[0]![0]!.data).toMatchObject({
      subjectType: "ISSUE", subjectNumber: 5, position: 2, columnId: "col-1",
    });
    expect(res.json().subject).toMatchObject({ type: "issue", number: 5 });
  });

  it("adds a PR (subjectType PULL_REQUEST)", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue({ id: "pr-3" } as never);
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.projectItem.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.projectItem.create).mockResolvedValue({
      id: "item-y", columnId: "col-1", position: 0, subjectType: "PULL_REQUEST", subjectNumber: 3, createdAt: new Date(),
    } as never);
    vi.mocked(prisma.issue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([{ number: 3, title: "PR", state: "OPEN" }] as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: writerToken }, payload: { columnId: "col-1", type: "pull", number: 3 },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.projectItem.create).mock.calls[0]![0]!.data).toMatchObject({ subjectType: "PULL_REQUEST", subjectNumber: 3 });
  });

  it("409 when the same subject is already on the board", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ id: "issue-5" } as never);
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue({ id: "existing" } as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: writerToken }, payload: { columnId: "col-1", type: "issue", number: 5 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404 when the referenced issue does not exist", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: writerToken }, payload: { columnId: "col-1", type: "issue", number: 999 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 on an invalid type", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: writerToken }, payload: { columnId: "col-1", type: "epic", number: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403 for a reader", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos/alice/my-repo/projects/1/items",
      headers: { authorization: readerToken }, payload: { columnId: "col-1", type: "issue", number: 5 },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Item move (position math) ──────────────────────────────────────────────────

describe("PATCH .../items/:itemId (move)", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
    vi.mocked(prisma.projectItem.update).mockResolvedValue({} as never);
  });

  it("same-column reorder: moving A to index 2 renumbers B,C,A to 0,1,2", async () => {
    const itemA = { id: "A", projectId: "proj-1", columnId: "col-1", subjectType: "ISSUE", subjectNumber: 1, position: 0 };
    vi.mocked(prisma.projectItem.findFirst)
      .mockResolvedValueOnce(itemA as never)                       // initial lookup
      .mockResolvedValueOnce({ ...itemA, position: 2 } as never);  // final reload
    // Destination (same col-1), excluding A → [B, C].
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([{ id: "B" }, { id: "C" }] as never);

    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/A",
      headers: { authorization: writerToken }, payload: { position: 2 },
    });
    expect(res.statusCode).toBe(200);
    const calls = vi.mocked(prisma.projectItem.update).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { where: { id: "B" }, data: { position: 0 } },
      { where: { id: "C" }, data: { position: 1 } },
      { where: { id: "A" }, data: { position: 2, columnId: "col-1" } },
    ]);
    expect(res.json()).toMatchObject({ id: "A", columnId: "col-1", position: 2 });
  });

  it("same-column reorder to the front (index 0)", async () => {
    const itemC = { id: "C", projectId: "proj-1", columnId: "col-1", subjectType: "ISSUE", subjectNumber: 3, position: 2 };
    vi.mocked(prisma.projectItem.findFirst)
      .mockResolvedValueOnce(itemC as never)
      .mockResolvedValueOnce({ ...itemC, position: 0 } as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([{ id: "A" }, { id: "B" }] as never);

    await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/C",
      headers: { authorization: writerToken }, payload: { position: 0 },
    });
    const calls = vi.mocked(prisma.projectItem.update).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { where: { id: "C" }, data: { position: 0, columnId: "col-1" } },
      { where: { id: "A" }, data: { position: 1 } },
      { where: { id: "B" }, data: { position: 2 } },
    ]);
  });

  it("cross-column move renumbers both destination and source", async () => {
    const itemA = { id: "A", projectId: "proj-1", columnId: "col-1", subjectType: "ISSUE", subjectNumber: 1, position: 0 };
    vi.mocked(prisma.projectItem.findFirst)
      .mockResolvedValueOnce(itemA as never)                                      // initial lookup
      .mockResolvedValueOnce({ ...itemA, columnId: "col-2", position: 1 } as never); // final reload
    vi.mocked(prisma.projectColumn.findFirst).mockResolvedValue({ id: "col-2", name: "Done", position: 1 } as never);
    // 1st findMany = destination col-2 (excluding A) → [X, Y]; 2nd = source col-1 remaining → [B, C].
    vi.mocked(prisma.projectItem.findMany)
      .mockResolvedValueOnce([{ id: "X" }, { id: "Y" }] as never)
      .mockResolvedValueOnce([{ id: "B" }, { id: "C" }] as never);

    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/A",
      headers: { authorization: writerToken }, payload: { columnId: "col-2", position: 1 },
    });
    expect(res.statusCode).toBe(200);
    const calls = vi.mocked(prisma.projectItem.update).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      // destination col-2: [X, A, Y] → 0,1,2
      { where: { id: "X" }, data: { position: 0 } },
      { where: { id: "A" }, data: { position: 1, columnId: "col-2" } },
      { where: { id: "Y" }, data: { position: 2 } },
      // source col-1 remaining: [B, C] → 0,1
      { where: { id: "B" }, data: { position: 0 } },
      { where: { id: "C" }, data: { position: 1 } },
    ]);
    expect(res.json()).toMatchObject({ columnId: "col-2", position: 1 });
  });

  it("clamps an out-of-range target index to the column end", async () => {
    const itemA = { id: "A", projectId: "proj-1", columnId: "col-1", subjectType: "ISSUE", subjectNumber: 1, position: 0 };
    vi.mocked(prisma.projectItem.findFirst)
      .mockResolvedValueOnce(itemA as never)
      .mockResolvedValueOnce({ ...itemA, position: 2 } as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([{ id: "B" }, { id: "C" }] as never);
    await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/A",
      headers: { authorization: writerToken }, payload: { position: 99 },
    });
    const calls = vi.mocked(prisma.projectItem.update).mock.calls.map((c) => c[0]);
    // A lands last (index 2).
    expect(calls[calls.length - 1]).toEqual({ where: { id: "A" }, data: { position: 2, columnId: "col-1" } });
  });

  it("404 when the item is not in this project", async () => {
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/nope",
      headers: { authorization: writerToken }, payload: { position: 0 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 when position is missing", async () => {
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(
      { id: "A", projectId: "proj-1", columnId: "col-1" } as never,
    );
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/A",
      headers: { authorization: writerToken }, payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("403 for a reader", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/repos/alice/my-repo/projects/1/items/A",
      headers: { authorization: readerToken }, payload: { position: 0 },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Item remove ────────────────────────────────────────────────────────────────

describe("DELETE .../items/:itemId (remove)", () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(makeProject() as never);
  });

  it("204 and renumbers the remaining cards in the column", async () => {
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(
      { id: "B", projectId: "proj-1", columnId: "col-1", position: 1 } as never,
    );
    vi.mocked(prisma.projectItem.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.projectItem.findMany).mockResolvedValue([{ id: "A" }, { id: "C" }] as never);
    vi.mocked(prisma.projectItem.update).mockResolvedValue({} as never);

    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1/items/B",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(204);
    const calls = vi.mocked(prisma.projectItem.update).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { where: { id: "A" }, data: { position: 0 } },
      { where: { id: "C" }, data: { position: 1 } },
    ]);
  });

  it("404 when the item is not in this project", async () => {
    vi.mocked(prisma.projectItem.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/my-repo/projects/1/items/nope",
      headers: { authorization: writerToken },
    });
    expect(res.statusCode).toBe(404);
  });
});
