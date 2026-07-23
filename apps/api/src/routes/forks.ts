import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { cloneMirror, syncForkBranch } from "../git-utils.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import { ingestCommitRange } from "../ingest.js";
import { emitPushEvents, ZERO_SHA } from "../push-events.js";
import { randomBytes } from "node:crypto";

/**
 * The Prisma `where` selecting the direct forks of `repoId` that `viewerId` is
 * allowed to see: public forks always, plus their own and any they collaborate
 * on. Keeps the forks list and the header fork count from leaking private forks.
 */
function readableForkWhere(repoId: string, viewerId: string | undefined) {
  if (!viewerId) return { forkedFromId: repoId, visibility: "PUBLIC" as const };
  return {
    forkedFromId: repoId,
    OR: [
      { visibility: "PUBLIC" as const },
      { ownerId: viewerId },
      { collaborators: { some: { userId: viewerId } } },
    ],
  };
}

export async function forkRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to sync a fork; session/JWT auth is unscoped
  // and no-ops this guard (mirrors branches/pulls). The route keeps its own
  // writer check on the fork.
  const write = app.requireScope("repo:write");

  // POST /repos/:handle/:name/fork
  app.post("/repos/:handle/:name/fork", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId === userId) return reply.status(400).send({ error: "Cannot fork your own repository" });

    // Check if user already has a repo with this name; suffix with -fork if needed
    let forkName = repo.name;
    const existing = await prisma.repo.findFirst({ where: { ownerId: userId, name: forkName } });
    if (existing) forkName = `${repo.name}-fork`;

    let forkStorageKey: string | null = null;
    if (repo.storageKey) {
      forkStorageKey = `forks/${randomBytes(12).toString("hex")}`;
      await cloneMirror(repo.storageKey, forkStorageKey);
    }

    const fork = await prisma.repo.create({
      data: {
        name: forkName,
        description: repo.description ? `Fork of ${handle}/${repo.name}. ${repo.description}` : `Fork of ${handle}/${repo.name}`,
        visibility: repo.visibility,
        ownerId: userId,
        storageKey: forkStorageKey,
        // Record lineage so the fork tracks its upstream (issue #113).
        forkedFromId: repo.id,
      },
    });

    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true } });

    return reply.status(201).send({
      id: fork.id,
      name: fork.name,
      owner: owner?.handle ?? userId,
      description: fork.description,
      visibility: fork.visibility,
      parent: { handle, name: repo.name },
      createdAt: fork.createdAt.toISOString(),
    });
  });

  // GET /repos/:handle/:name/forks — direct forks the caller is allowed to see.
  app.get("/repos/:handle/:name/forks", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const forks = await prisma.repo.findMany({
      where: readableForkWhere(repo.id, userId),
      orderBy: { updatedAt: "desc" },
      include: { owner: { select: { handle: true } } },
    });

    return {
      forks: forks.map((f) => ({
        id: f.id,
        name: f.name,
        ownerHandle: f.owner?.handle ?? "",
        fullName: f.owner ? `${f.owner.handle}/${f.name}` : f.name,
        description: f.description,
        visibility: f.visibility === "PUBLIC" ? "public" : "private",
        updatedAt: f.updatedAt.toISOString(),
      })),
    };
  });

  // POST /repos/:handle/:name/sync — pull upstream changes into a fork's default
  // branch (fast-forward-only; a diverged fork is reported, never force-synced).
  app.post("/repos/:handle/:name/sync", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.forkedFromId) return reply.status(400).send({ error: "Repository is not a fork" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    // Load the upstream and enforce read visibility — you can't sync from a
    // parent you're not allowed to see (treat as if it doesn't exist).
    const parent = await prisma.repo.findUnique({
      where: { id: repo.forkedFromId },
      include: { collaborators: { select: { userId: true, role: true } } },
    });
    if (!parent || !canRead(parent, userId)) return reply.status(404).send({ error: "Upstream not found" });
    if (!parent.storageKey) return reply.status(400).send({ error: "Upstream has no git storage" });

    const result = await syncForkBranch(repo.storageKey, parent.storageKey);

    if (result.status === "fast-forwarded" && result.newSha) {
      const repoId = repo.id;
      const storageKey = repo.storageKey;
      const repoPath = bareRepoPathFromKey(storageKey);
      const oldSha = result.oldSha ?? ZERO_SHA;
      const newSha = result.newSha;
      // The fork's branch tip moved: fire the same `push` webhooks + CI a client
      // push would, and re-ingest any artifacts the pulled range introduces —
      // so an upstream sync is indistinguishable from a normal push downstream.
      emitPushEvents(repoId, storageKey, userId, [{ branch: result.branch, oldSha, newSha }]);
      setImmediate(() => {
        ingestCommitRange(repoId, repoPath, oldSha, newSha).catch(() => {});
      });
    }

    return reply.send({ status: result.status, ahead: result.ahead, behind: result.behind });
  });
}
