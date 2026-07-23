import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
    workflowRun: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    checkRun: { findFirst: vi.fn() },
  },
}));

// The runner is mocked so the write routes never kick real background execution.
vi.mock("../ci/runner.js", () => ({
  isCiEnabled: vi.fn(() => true),
  enqueueRun: vi.fn(),
  cancelRun: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../prisma.js";
import { cancelRun, isCiEnabled } from "../ci/runner.js";
import { hashToken } from "../tokens.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER = "owner-1";
const OUTSIDER = "outsider-2";

/** Route a presented PAT (by its hash) to a scope string, else 401. */
function wirePats(byHash: Record<string, { userId: string; scopes: string }>) {
  vi.mocked(prisma.personalAccessToken.findUnique).mockImplementation(((args: { where: { tokenHash: string } }) => {
    const rec = byHash[args.where.tokenHash];
    return Promise.resolve(rec ? { id: "pat", userId: rec.userId, scopes: rec.scopes, expiresAt: null } : null);
  }) as never);
  vi.mocked(prisma.personalAccessToken.update).mockResolvedValue({} as never);
}

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

// ─── POST re-run / cancel (writer-gated, v1) ─────────────────────────────────────

/** A full run row shaped for serializeRun. */
function fullRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-new", commitSha: "abcdef1234567890", trigger: "push", ref: "main", prId: null,
    workflowName: "CI", workflowPath: ".forgehub/workflows/ci.yml",
    status: "queued", conclusion: null, rerunOfId: "run-1",
    createdAt: new Date("2026-07-23T00:00:00Z"), startedAt: null, completedAt: null,
    checkRuns: [{ id: "chk-1", jobId: "build", jobName: "Build", status: "queued", conclusion: null, startedAt: null, completedAt: null, logPath: null }],
    ...overrides,
  };
}

const READ_TOKEN = "fhp_read";
const WRITE_TOKEN = "fhp_write";

describe("POST re-run", () => {
  beforeEach(() => {
    vi.mocked(isCiEnabled).mockReturnValue(true);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never); // retention no-op
    vi.mocked(prisma.workflowRun.deleteMany).mockResolvedValue({} as never);
    vi.mocked(prisma.workflowRun.create).mockResolvedValue({ id: "run-new" } as never);
  });

  it("owner (session) re-runs → 201 with a fresh run linked to the source", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst)
      .mockResolvedValueOnce({ id: "run-1", commitSha: "abcdef1234567890", trigger: "push", ref: "main", prId: null, workflowName: "CI", workflowPath: ".forgehub/workflows/ci.yml", checkRuns: [{ jobId: "build", jobName: "Build" }] } as never)
      .mockResolvedValueOnce(fullRun() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/rerun",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe("run-new");
    expect(res.json().rerunOfId).toBe("run-1");
    // The source run's job set was cloned into the new run.
    const createArg = vi.mocked(prisma.workflowRun.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(createArg.rerunOfId).toBe("run-1");
  });

  it("403s a repo:read PAT (missing repo:write)", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    wirePats({ [hashToken(READ_TOKEN)]: { userId: OWNER, scopes: "repo:read" } });
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/rerun",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
  });

  it("403s a non-writer session on a public repo", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/rerun",
      headers: { authorization: await authHeader(app, OUTSIDER) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s when CI is disabled on the instance", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(isCiEnabled).mockReturnValue(false);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/rerun",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s when the source run does not exist", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/nope/rerun",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST cancel", () => {
  it("owner cancels a running run → invokes the runner and returns the run", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst)
      .mockResolvedValueOnce({ id: "run-1", status: "running" } as never)
      .mockResolvedValueOnce(fullRun({ id: "run-1", status: "running", rerunOfId: null }) as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/cancel",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(200);
    expect(cancelRun).toHaveBeenCalledWith("run-1");
  });

  it("409s cancelling an already-completed run", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValue({ id: "run-1", status: "completed" } as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/cancel",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s cancelling an unknown run", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/nope/cancel",
      headers: { authorization: await authHeader(app, OWNER) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s a repo:read PAT (missing repo:write)", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    wirePats({ [hashToken(READ_TOKEN)]: { userId: OWNER, scopes: "repo:read" } });
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/cancel",
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("repo:write");
  });

  it("allows a repo:write PAT to cancel", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(publicRepo() as never);
    wirePats({ [hashToken(WRITE_TOKEN)]: { userId: OWNER, scopes: "repo:read,repo:write" } });
    vi.mocked(prisma.workflowRun.findFirst)
      .mockResolvedValueOnce({ id: "run-1", status: "queued" } as never)
      .mockResolvedValueOnce(fullRun({ id: "run-1", status: "queued", rerunOfId: null }) as never);
    const res = await app.inject({
      method: "POST",
      url: "/repos/owner/widget/actions/runs/run-1/cancel",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
