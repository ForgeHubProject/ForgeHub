import type { FastifyInstance } from "fastify";
import { fetchGithubRepo, ImportError, parseGithubRepo, runGithubImport } from "./github-import.js";
import { startIssueImportIfAsked } from "./github-issue-import.js";
import { prisma } from "./prisma.js";

// Imports wait their turn (#308). A person's GitHub imports fetch one at a time,
// oldest first: an import started while another runs is "queued", and so is every
// repository of an organization import. The queue is the repositories themselves
// (importStatus "queued", keyed by ownerId), so it survives a restart.
//
// Each repository's issues, pull requests and releases (#289, phase 2 and 3) run
// as their own job once its git history is in; the queue moves on without waiting.

/** Owners whose queue is being worked through in this process. */
const running = new Set<string>();
/** Owners whose queue was asked to run while it already ran: look again when done. */
const again = new Set<string>();
/** Queues waiting for GitHub's hourly requests to come back. */
const waiting = new Map<string, NodeJS.Timeout>();

/** An import is under way for these: fetching, or waiting in line. */
export const IMPORT_BUSY = ["importing", "queued"];

/** Whether a person already has an import fetching or waiting, so a new one joins the queue. */
export async function hasImportsUnderWay(ownerId: string): Promise<boolean> {
  return (await prisma.repo.count({ where: { ownerId, importStatus: { in: IMPORT_BUSY } } })) > 0;
}

/** Work through a person's queued imports, one at a time. Never throws. */
export async function runImportQueue(app: FastifyInstance, ownerId: string): Promise<void> {
  if (running.has(ownerId)) {
    again.add(ownerId);
    return;
  }
  running.add(ownerId);
  try {
    do {
      again.delete(ownerId);
      await drain(app, ownerId);
    } while (again.has(ownerId));
  } finally {
    running.delete(ownerId);
  }
}

async function drain(app: FastifyInstance, ownerId: string): Promise<void> {
  try {
    for (;;) {
      // An import started on its own runs outside the queue; its end starts the queue again.
      if (await prisma.repo.count({ where: { ownerId, importStatus: "importing" } })) return;
      const next = await prisma.repo.findFirst({
        where: { ownerId, importStatus: "queued" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, storageKey: true, importSource: true, description: true, _count: { select: { topics: true } } },
      });
      if (!next) return;
      const resetAt = await runQueued(app, next, ownerId);
      if (resetAt) {
        waitFor(app, ownerId, resetAt);
        return;
      }
    }
  } catch (err) {
    app.log.error({ err }, "working through GitHub imports failed");
  }
}

/** Pick the queue up again a little after GitHub's limit resets. The timer never keeps the process alive. */
function waitFor(app: FastifyInstance, ownerId: string, at: Date): void {
  clearTimeout(waiting.get(ownerId));
  const ms = Math.min(Math.max(1000, at.getTime() - Date.now() + 5000), 2 ** 31 - 1);
  const timer = setTimeout(() => {
    waiting.delete(ownerId);
    void runImportQueue(app, ownerId);
  }, ms);
  timer.unref();
  waiting.set(ownerId, timer);
}

/**
 * Import one queued repository: ask GitHub about it now (it may have changed since
 * it was picked), fetch it, then start its issue import. Returns when to try again
 * if GitHub's hourly requests ran out; the repository then stays first in line.
 */
async function runQueued(
  app: FastifyInstance,
  repo: { id: string; storageKey: string | null; importSource: string | null; description: string | null; _count: { topics: number } },
  actorId: string,
): Promise<Date | null> {
  // Conditional, so it starts once even if it was deleted or retried meanwhile.
  const { count } = await prisma.repo.updateMany({
    where: { id: repo.id, importStatus: "queued" },
    data: { importStatus: "importing", importError: null },
  });
  if (count === 0) return null;
  const fail = (importError: string) =>
    prisma.repo.updateMany({ where: { id: repo.id, importStatus: "importing" }, data: { importStatus: "failed", importError } });

  const from = repo.importSource ? parseGithubRepo(repo.importSource) : null;
  if (!from || !repo.storageKey) {
    await fail("This repository has no GitHub repository to import from.");
    return null;
  }
  let source;
  try {
    source = await fetchGithubRepo(from.owner, from.name);
  } catch (e) {
    if (e instanceof ImportError && e.resetAt) {
      await prisma.repo.updateMany({ where: { id: repo.id, importStatus: "importing" }, data: { importStatus: "queued" } });
      return e.resetAt;
    }
    await fail(e instanceof ImportError ? e.message : "Could not reach GitHub. Try again later.");
    return null;
  }
  // Its description and topics, as an import started on its own takes them; never over the person's.
  await prisma.repo
    .update({
      where: { id: repo.id },
      data: {
        ...(repo.description === null && source.description && { description: source.description }),
        ...(repo._count.topics === 0 && source.topics.length > 0 && { topics: { create: source.topics.map((topic) => ({ topic })) } }),
      },
    })
    .catch(() => {}); // deleted meanwhile: runGithubImport finds out too
  await runGithubImport(app, { id: repo.id, storageKey: repo.storageKey }, actorId, source);
  await startIssueImportIfAsked(app, repo.id);
  return null;
}

/** At boot, after interrupted imports are marked failed: carry on with every queue. */
export async function resumeImportQueues(app: FastifyInstance): Promise<number> {
  const owners = await prisma.repo.findMany({
    where: { importStatus: "queued" },
    distinct: ["ownerId"],
    select: { ownerId: true },
  });
  for (const { ownerId } of owners) void runImportQueue(app, ownerId);
  return owners.length;
}
