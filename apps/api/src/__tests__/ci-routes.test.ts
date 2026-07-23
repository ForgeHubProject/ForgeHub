import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
    workflowRun: { findMany: vi.fn(), findFirst: vi.fn() },
    checkRun: { findFirst: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER = "owner-1";
const OUTSIDER = "outsider-2";

function publicRepo(overrides: Record<string, unknown> = {}) {
  return { id: "repo-1", name: "widget", ownerId: OWNER, visibility: "PUBLIC", storageKey: "owner/widget.git", collaborators: [], ...overrides };
}
function privateRepo(overrides: Record<string, unknown> = {}) {
  return publicRepo({ visibility: "PRIVATE", ...overrides });
}

let app: FastifyInstance;
beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); });

describe("GET check-summary (contract)", () => {
  it("aggregates mixed check states across runs", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] },
      { checkRuns: [{ status: "running", conclusion: null }, { status: "queued", conclusion: null }] },
    ] as never);

    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/commits/abc123/check-summary" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 4, passing: 1, failing: 1, pending: 2 });
  });

  it("404s when the repo has no runs for the sha", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/commits/deadbeef/check-summary" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a non-reader of a private repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(privateRepo() as never);
    // Guest (no token) and an unrelated user both get 404, never 403.
    const guest = await app.inject({ method: "GET", url: "/repos/owner/widget/commits/abc/check-summary" });
    expect(guest.statusCode).toBe(404);
    const outsider = await app.inject({
      method: "GET",
      url: "/repos/owner/widget/commits/abc/check-summary",
      headers: { authorization: await authHeader(app, OUTSIDER) },
    });
    expect(outsider.statusCode).toBe(404);
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
  });

  it("lets a private-repo owner read the summary", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(privateRepo() as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { checkRuns: [{ status: "completed", conclusion: "success" }] },
    ] as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/owner/widget/commits/abc/check-summary",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 });
  });
});

describe("GET commit-statuses (batch)", () => {
  it("returns a per-sha summary map, only for shas with runs", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      { commitSha: "sha-a", checkRuns: [{ status: "completed", conclusion: "success" }] },
      { commitSha: "sha-a", checkRuns: [{ status: "running", conclusion: null }] },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/commit-statuses?shas=sha-a,sha-b" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statuses: { "sha-a": { total: 2, passing: 1, failing: 0, pending: 1 } } });
  });

  it("returns an empty map when no shas are given", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/commit-statuses" });
    expect(res.json()).toEqual({ statuses: {} });
  });
});

describe("GET runs list + detail", () => {
  const runRow = {
    id: "run-1", commitSha: "abcdef1234567890", trigger: "push", ref: "main", prId: null,
    workflowName: "CI", workflowPath: ".forgehub/workflows/ci.yml",
    status: "completed", conclusion: "success",
    createdAt: new Date("2026-07-23T00:00:00Z"), startedAt: new Date("2026-07-23T00:00:01Z"), completedAt: new Date("2026-07-23T00:00:05Z"),
    checkRuns: [{ id: "chk-1", jobId: "build", jobName: "Build", status: "completed", conclusion: "success", startedAt: new Date("2026-07-23T00:00:01Z"), completedAt: new Date("2026-07-23T00:00:05Z"), logPath: "/tmp/x.log" }],
  };

  it("lists runs with a summary and check rows", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([runRow] as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/actions/runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].shortSha).toBe("abcdef1");
    expect(body.runs[0].summary).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 });
    expect(body.runs[0].checkRuns[0].hasLog).toBe(true);
    expect(body.runs[0].checkRuns[0]).not.toHaveProperty("logPath"); // never leak the disk path
  });

  it("returns run detail, 404 for an unknown run", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValueOnce(runRow as never);
    const ok = await app.inject({ method: "GET", url: "/repos/owner/widget/actions/runs/run-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe("run-1");

    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValueOnce(null as never);
    const missing = await app.inject({ method: "GET", url: "/repos/owner/widget/actions/runs/nope" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET job log", () => {
  let dir: string;
  let logPath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ci-log-test-"));
    logPath = join(dir, "build.log");
    await writeFile(logPath, "=== Build ===\n$ echo hi\nhi\n", "utf8");
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("streams the log as text/plain", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.checkRun.findFirst).mockResolvedValue({ logPath } as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/actions/runs/run-1/checks/chk-1/log" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("echo hi");
  });

  it("404s when the check has no log", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.checkRun.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({ method: "GET", url: "/repos/owner/widget/actions/runs/run-1/checks/none/log" });
    expect(res.statusCode).toBe(404);
  });
});
