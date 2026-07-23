import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { summarizeCheckRuns, type CheckSummary } from "../ci/summary.js";

/**
 * Actions-style CI read API (issue #86).
 *
 *   GET /repos/:h/:n/commits/:sha/check-summary   ← CONTRACT (branch protection #85)
 *   GET /repos/:h/:n/commit-statuses?shas=a,b,c   ← batch, for commit-list dots
 *   GET /repos/:h/:n/actions/runs?sha=&prId=      ← runs list
 *   GET /repos/:h/:n/actions/runs/:id             ← run detail (+ check runs)
 *   GET /repos/:h/:n/actions/runs/:id/checks/:cid/log  ← plain-text job log
 *
 * All routes are canRead-gated (private repo → 404 for non-readers, never 403,
 * matching the rest of the repo API). Writes happen only through the git
 * post-receive hook and the PR routes — there is no public "start a run" endpoint
 * in v0.
 */

type CheckRunRow = {
  id: string;
  jobId: string;
  jobName: string;
  status: string;
  conclusion: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  logPath: string | null;
};

type RunRow = {
  id: string;
  commitSha: string;
  trigger: string;
  ref: string | null;
  prId: string | null;
  workflowName: string;
  workflowPath: string;
  status: string;
  conclusion: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  checkRuns: CheckRunRow[];
};

function serializeCheck(c: CheckRunRow) {
  return {
    id: c.id,
    jobId: c.jobId,
    jobName: c.jobName,
    status: c.status,
    conclusion: c.conclusion,
    startedAt: c.startedAt?.toISOString() ?? null,
    completedAt: c.completedAt?.toISOString() ?? null,
    hasLog: c.logPath != null,
  };
}

function serializeRun(run: RunRow) {
  const summary = summarizeCheckRuns(run.checkRuns);
  return {
    id: run.id,
    commitSha: run.commitSha,
    shortSha: run.commitSha.slice(0, 7),
    trigger: run.trigger,
    ref: run.ref,
    prId: run.prId,
    workflowName: run.workflowName,
    workflowPath: run.workflowPath,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    summary,
    checkRuns: run.checkRuns.map(serializeCheck),
  };
}

export async function ciRoutes(app: FastifyInstance) {
  // ── GET check-summary (CONTRACT) ──────────────────────────────────────────────
  // {total, passing, failing, pending} across every CheckRun of every WorkflowRun
  // for this sha. 404 when the repo has no runs for the sha.
  app.get("/repos/:handle/:name/commits/:sha/check-summary", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, sha } = request.params as { handle: string; name: string; sha: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const runs = await prisma.workflowRun.findMany({
      where: { repoId: repo.id, commitSha: sha },
      select: { checkRuns: { select: { status: true, conclusion: true } } },
    });
    if (runs.length === 0) return reply.status(404).send({ error: "No runs for this commit" });

    const checks = runs.flatMap((r) => r.checkRuns);
    const summary: CheckSummary = summarizeCheckRuns(checks);
    return summary;
  });

  // ── GET commit-statuses (batch for the commit list) ───────────────────────────
  // ?shas=comma,separated → { statuses: { <sha>: {total,passing,failing,pending} } }
  // Only shas that actually have runs appear in the map.
  app.get("/repos/:handle/:name/commit-statuses", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { shas: shasRaw } = request.query as { shas?: string };
    const shas = (shasRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (shas.length === 0) return { statuses: {} };

    const runs = await prisma.workflowRun.findMany({
      where: { repoId: repo.id, commitSha: { in: shas } },
      select: { commitSha: true, checkRuns: { select: { status: true, conclusion: true } } },
    });

    const byCommit = new Map<string, Array<{ status: string; conclusion: string | null }>>();
    for (const run of runs) {
      const list = byCommit.get(run.commitSha) ?? [];
      list.push(...run.checkRuns);
      byCommit.set(run.commitSha, list);
    }
    const statuses: Record<string, CheckSummary> = {};
    for (const [sha, checks] of byCommit) statuses[sha] = summarizeCheckRuns(checks);
    return { statuses };
  });

  // ── GET runs list ─────────────────────────────────────────────────────────────
  app.get("/repos/:handle/:name/actions/runs", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { sha, prId } = request.query as { sha?: string; prId?: string };
    const runs = await prisma.workflowRun.findMany({
      where: {
        repoId: repo.id,
        ...(sha ? { commitSha: sha } : {}),
        ...(prId ? { prId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { checkRuns: true },
    });
    return { runs: runs.map(serializeRun) };
  });

  // ── GET run detail ────────────────────────────────────────────────────────────
  app.get("/repos/:handle/:name/actions/runs/:id", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, id } = request.params as { handle: string; name: string; id: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const run = await prisma.workflowRun.findFirst({
      where: { id, repoId: repo.id },
      include: { checkRuns: true },
    });
    if (!run) return reply.status(404).send({ error: "Run not found" });
    return serializeRun(run);
  });

  // ── GET job log (text/plain) ──────────────────────────────────────────────────
  app.get("/repos/:handle/:name/actions/runs/:id/checks/:checkId/log", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, id, checkId } = request.params as { handle: string; name: string; id: string; checkId: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const check = await prisma.checkRun.findFirst({
      where: { id: checkId, workflowRunId: id, workflowRun: { repoId: repo.id } },
      select: { logPath: true },
    });
    if (!check || !check.logPath) return reply.status(404).send({ error: "Log not found" });

    let content: string;
    try {
      content = await readFile(check.logPath, "utf8");
    } catch {
      return reply.status(404).send({ error: "Log not found" });
    }
    return reply.type("text/plain").send(content);
  });
}
