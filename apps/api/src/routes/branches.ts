import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { branchExists, countAheadBehind, createBranch, defaultBranch, deleteBranch, listBranches } from "../git-utils.js";

export async function branchRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/branches
  app.get("/repos/:handle/:name/branches", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.send({ branches: [], defaultBranch: "main" });
    const [branches, def] = await Promise.all([
      listBranches(repo.storageKey),
      defaultBranch(repo.storageKey),
    ]);
    // If HEAD points to a branch with no commits, fall back to the first real branch
    const resolvedDefault = branches.some((b) => b.name === def) ? def : (branches[0]?.name ?? def);
    // Annotate protected status
    const protected_ = await prisma.protectedBranch.findMany({ where: { repoId: repo.id }, select: { branch: true } });
    const protectedSet = new Set(protected_.map((p) => p.branch));
    // Ahead/behind vs the default branch (0/0 for the default itself). Computed in
    // parallel — one cheap rev-list per branch.
    const storageKey = repo.storageKey;
    const enriched = await Promise.all(
      branches.map(async (b) => {
        const { ahead, behind } = b.name === resolvedDefault
          ? { ahead: 0, behind: 0 }
          : await countAheadBehind(storageKey, resolvedDefault, b.name);
        return { ...b, protected: protectedSet.has(b.name), ahead, behind };
      }),
    );
    return { branches: enriched, defaultBranch: resolvedDefault };
  });

  // POST /repos/:handle/:name/branches
  app.post("/repos/:handle/:name/branches", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const { branch, from = "HEAD" } = request.body as { branch?: string; from?: string };
    if (!branch || !/^[\w/._-]+$/.test(branch)) return reply.status(400).send({ error: "Invalid branch name" });
    if (await branchExists(repo.storageKey, branch)) return reply.status(409).send({ error: "Branch already exists" });

    try {
      await createBranch(repo.storageKey, branch, from);
      return reply.status(201).send({ branch });
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  // DELETE /repos/:handle/:name/branches/:branch
  app.delete("/repos/:handle/:name/branches/:branch", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, branch } = request.params as { handle: string; name: string; branch: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    // Refuse to delete a protected branch
    const isProtected = await prisma.protectedBranch.findFirst({ where: { repoId: repo.id, branch } });
    if (isProtected) return reply.status(403).send({ error: "Branch is protected" });

    const def = await defaultBranch(repo.storageKey);
    if (branch === def) return reply.status(400).send({ error: "Cannot delete the default branch" });

    try {
      await deleteBranch(repo.storageKey, branch, true);
      return reply.status(204).send();
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  // GET /repos/:handle/:name/branches/:branch/protection
  app.get("/repos/:handle/:name/branches/:branch/protection", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, branch } = request.params as { handle: string; name: string; branch: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    const row = await prisma.protectedBranch.findFirst({ where: { repoId: repo.id, branch } });
    return { branch, protected: !!row };
  });

  // PUT /repos/:handle/:name/branches/:branch/protection
  app.put("/repos/:handle/:name/branches/:branch/protection", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, branch } = request.params as { handle: string; name: string; branch: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId !== userId) return reply.status(403).send({ error: "Only the owner can protect branches" });

    await prisma.protectedBranch.upsert({
      where: { repoId_branch: { repoId: repo.id, branch } },
      create: { repoId: repo.id, branch },
      update: {},
    });
    return { branch, protected: true };
  });

  // DELETE /repos/:handle/:name/branches/:branch/protection
  app.delete("/repos/:handle/:name/branches/:branch/protection", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, branch } = request.params as { handle: string; name: string; branch: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (repo.ownerId !== userId) return reply.status(403).send({ error: "Only the owner can unprotect branches" });

    await prisma.protectedBranch.deleteMany({ where: { repoId: repo.id, branch } });
    return reply.status(204).send();
  });
}
