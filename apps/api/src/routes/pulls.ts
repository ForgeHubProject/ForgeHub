import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { branchExists, defaultBranch, getMergeBaseDiff, getMergeBaseFileList, listMergeBaseCommits, performMerge, performRebaseMerge, performRevert, performSquashMerge, resolveBranchSha, type CommitAuthor, type MergeMethod } from "../git-utils.js";
import { notifySubscribers } from "../notifications-service.js";
import { resolvePullRequestMerge, type MergeFileResolution } from "../merge/resolve-pull.js";
import { ingestCommitRange } from "../ingest.js";
import { bareRepoPathFromKey } from "../git-storage.js";

const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

/** Resolve the git author identity for a user performing a merge/revert. */
async function resolveActorIdentity(userId: string): Promise<CommitAuthor> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { handle: true, displayName: true, email: true },
  });
  const name = user?.displayName?.trim() || user?.handle || "ForgeHub";
  const email = user?.email || "merge@forgehub.io";
  return { name, email };
}

export async function pullRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/pulls
  app.get("/repos/:handle/:name/pulls", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { state = "open" } = request.query as { state?: string };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const stateFilter =
      state === "closed" ? "CLOSED"
      : state === "merged" ? "MERGED"
      : state === "all" ? undefined
      : "OPEN";

    const pulls = await prisma.pullRequest.findMany({
      where: { repoId: repo.id, ...(stateFilter ? { state: stateFilter } : {}) },
      orderBy: { number: "desc" },
      include: { author: { select: { handle: true, displayName: true } } },
    });

    return {
      pulls: pulls.map((p) => ({
        id: p.id,
        number: p.number,
        title: p.title,
        description: p.description,
        fromBranch: p.fromBranch,
        toBranch: p.toBranch,
        state: p.state.toLowerCase(),
        mergedAt: p.mergedAt?.toISOString() ?? null,
        author: p.author.handle,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    };
  });

  // POST /repos/:handle/:name/pulls
  app.post("/repos/:handle/:name/pulls", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const { title, description, fromBranch, toBranch } = request.body as {
      title?: string; description?: string; fromBranch?: string; toBranch?: string;
    };

    if (!title?.trim()) return reply.status(400).send({ error: "title is required" });
    if (!fromBranch) return reply.status(400).send({ error: "fromBranch is required" });

    const def = toBranch || await defaultBranch(repo.storageKey);
    if (!(await branchExists(repo.storageKey, fromBranch)))
      return reply.status(400).send({ error: `Branch '${fromBranch}' not found` });
    if (!(await branchExists(repo.storageKey, def)))
      return reply.status(400).send({ error: `Branch '${def}' not found` });
    if (fromBranch === def) return reply.status(400).send({ error: "fromBranch and toBranch must differ" });

    // Check for duplicate open PR
    const dup = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, fromBranch, toBranch: def, state: "OPEN" },
    });
    if (dup) return reply.status(409).send({ error: "An open pull request already exists for this branch pair" });

    const count = await prisma.pullRequest.count({ where: { repoId: repo.id } });
    const pr = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number: count + 1,
        title: title.trim(),
        description: description?.trim() || null,
        fromBranch,
        toBranch: def,
        state: "OPEN",
        authorId: userId,
      },
      include: { author: { select: { handle: true } } },
    });

    void notifySubscribers({ actorId: userId, repoId: repo.id, subjectType: "PULL_REQUEST", subjectId: pr.id, subjectTitle: pr.title, reason: "SUBSCRIBED" });

    return reply.status(201).send({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      description: pr.description,
      fromBranch: pr.fromBranch,
      toBranch: pr.toBranch,
      state: pr.state.toLowerCase(),
      mergedAt: null,
      author: pr.author.handle,
      createdAt: pr.createdAt.toISOString(),
      updatedAt: pr.updatedAt.toISOString(),
    });
  });

  // GET /repos/:handle/:name/pulls/:number
  app.get("/repos/:handle/:name/pulls/:number", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const pr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, number: Number(number) },
      include: { author: { select: { handle: true, displayName: true } } },
    });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    // Compute mergeable status if open and has storage
    let mergeable: boolean | null = null;
    if (pr.state === "OPEN" && repo.storageKey) {
      try {
        const fromSha = await resolveBranchSha(repo.storageKey, pr.fromBranch);
        const toSha = await resolveBranchSha(repo.storageKey, pr.toBranch);
        mergeable = !!(fromSha && toSha);
      } catch { mergeable = false; }
    }

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      description: pr.description,
      fromBranch: pr.fromBranch,
      toBranch: pr.toBranch,
      state: pr.state.toLowerCase(),
      mergeable,
      mergedAt: pr.mergedAt?.toISOString() ?? null,
      mergeMethod: pr.mergeMethod ?? null,
      author: pr.author.handle,
      createdAt: pr.createdAt.toISOString(),
      updatedAt: pr.updatedAt.toISOString(),
    };
  });

  // POST /repos/:handle/:name/pulls/:number/merge
  app.post("/repos/:handle/:name/pulls/:number/merge", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });
    if (pr.state !== "OPEN") return reply.status(409).send({ error: `Pull request is ${pr.state.toLowerCase()}` });

    const { commitMessage, mergeMethod: rawMethod } = (request.body ?? {}) as { commitMessage?: string; mergeMethod?: string };
    const mergeMethod: MergeMethod = (rawMethod ?? "merge") as MergeMethod;
    if (!MERGE_METHODS.includes(mergeMethod)) {
      return reply.status(400).send({ error: `mergeMethod must be one of: ${MERGE_METHODS.join(", ")}` });
    }
    const message = commitMessage?.trim() || `Merge '${pr.fromBranch}' into '${pr.toBranch}' (#${pr.number})`;

    // Capture the toBranch SHA before merge for ingestion range
    const beforeSha = await resolveBranchSha(repo.storageKey, pr.toBranch);

    let result: Awaited<ReturnType<typeof performMerge>>;
    try {
      if (mergeMethod === "squash") {
        // Single squashed commit authored as the merger: "<title> (!N)" + subjects.
        const prCommits = await listMergeBaseCommits(repo.storageKey, pr.toBranch, pr.fromBranch);
        const subjects = prCommits.map((c) => `* ${c.subject}`).join("\n");
        const subject = commitMessage?.trim() || `${pr.title} (!${pr.number})`;
        const squashMessage = subjects ? `${subject}\n\n${subjects}\n` : `${subject}\n`;
        const author = await resolveActorIdentity(userId);
        result = await performSquashMerge(repo.storageKey, pr.fromBranch, pr.toBranch, squashMessage, author);
      } else if (mergeMethod === "rebase") {
        result = await performRebaseMerge(repo.storageKey, pr.fromBranch, pr.toBranch);
      } else {
        result = await performMerge(repo.storageKey, pr.fromBranch, pr.toBranch, message);
      }
    } catch (err) {
      app.log.error({ err }, "merge threw unexpectedly");
      return reply.status(500).send({ error: "Merge failed due to a server error" });
    }

    if (!result.ok) {
      if ("alreadyMerged" in result) return reply.status(409).send({ error: "Branch is already merged" });
      const conflictError =
        mergeMethod === "rebase" ? "Rebase conflict — commits could not be replayed cleanly onto the base branch"
        : mergeMethod === "squash" ? "Squash conflict — cannot auto-merge"
        : "Merge conflict — cannot auto-merge";
      return reply.status(409).send({ error: conflictError, resolvable: true });
    }

    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { state: "MERGED", mergedAt: new Date(), mergeMethod, mergeCommitSha: result.sha },
    });

    // Fire-and-forget: ingest any new .gltf files introduced by the merge
    if (beforeSha && result.sha) {
      const repoPath = bareRepoPathFromKey(repo.storageKey);
      const repoId = repo.id;
      const afterSha = result.sha;
      setImmediate(() => {
        ingestCommitRange(repoId, repoPath, beforeSha, afterSha).catch(() => {});
      });
    }

    return { merged: true, sha: result.sha, method: mergeMethod };
  });

  // POST /repos/:handle/:name/pulls/:number/merge-resolve — resolve a conflict with ours/theirs
  app.post("/repos/:handle/:name/pulls/:number/merge-resolve", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });
    if (pr.state !== "OPEN") return reply.status(409).send({ error: `Pull request is ${pr.state.toLowerCase()}` });

    const body = request.body as {
      strategy?: string;
      commitMessage?: string;
      files?: MergeFileResolution[];
    };

    const hasFiles = Array.isArray(body.files) && body.files.length > 0;
    const strategy = body.strategy;
    if (!hasFiles && strategy !== "ours" && strategy !== "theirs") {
      return reply.status(400).send({
        error: "Provide strategy ('ours' | 'theirs') or a non-empty files resolution list",
      });
    }

    const message =
      body.commitMessage?.trim()
      || (hasFiles
        ? `Merge '${pr.fromBranch}' into '${pr.toBranch}' (#${pr.number}) [granular]`
        : `Merge '${pr.fromBranch}' into '${pr.toBranch}' (#${pr.number}) [resolved: ${strategy}]`);

    const beforeSha = await resolveBranchSha(repo.storageKey, pr.toBranch);

    let result: Awaited<ReturnType<typeof resolvePullRequestMerge>>;
    try {
      result = hasFiles
        ? await resolvePullRequestMerge(
            repo.storageKey,
            repo.id,
            pr.toBranch,
            pr.fromBranch,
            message,
            { files: body.files! },
          )
        : await resolvePullRequestMerge(
            repo.storageKey,
            repo.id,
            pr.toBranch,
            pr.fromBranch,
            message,
            { strategy: strategy as "ours" | "theirs" },
          );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Merge failed";
      app.log.error({ err }, "merge-resolve failed");
      return reply.status(400).send({ error: msg });
    }

    if (!result.ok) {
      if ("alreadyMerged" in result) return reply.status(409).send({ error: "Branch is already merged" });
      return reply.status(409).send({ error: "Merge conflict could not be resolved automatically" });
    }

    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { state: "MERGED", mergedAt: new Date(), mergeMethod: "merge", mergeCommitSha: result.sha },
    });

    if (beforeSha && result.sha) {
      const repoPath = bareRepoPathFromKey(repo.storageKey);
      const repoId = repo.id;
      const afterSha = result.sha;
      setImmediate(() => {
        ingestCommitRange(repoId, repoPath, beforeSha, afterSha).catch(() => {});
      });
    }

    return { merged: true, sha: result.sha };
  });

  // POST /repos/:handle/:name/pulls/:number/revert — open a PR reverting a merged PR
  app.post("/repos/:handle/:name/pulls/:number/revert", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });
    if (pr.state !== "MERGED") return reply.status(409).send({ error: "Only a merged pull request can be reverted" });
    if (!pr.mergeCommitSha) {
      return reply.status(409).send({ error: "No merge commit is recorded for this pull request, so it cannot be reverted" });
    }

    // The reverting branch (revert-pr-N) is pushed on the first revert; its
    // existence guards against opening a duplicate revert for the same PR.
    const revertBranch = `revert-pr-${pr.number}`;
    if (await branchExists(repo.storageKey, revertBranch)) {
      return reply.status(409).send({ error: `Branch '${revertBranch}' already exists — this pull request was already reverted` });
    }

    const author = await resolveActorIdentity(userId);
    const beforeSha = await resolveBranchSha(repo.storageKey, pr.toBranch);

    let result: Awaited<ReturnType<typeof performRevert>>;
    try {
      result = await performRevert(repo.storageKey, pr.toBranch, pr.mergeCommitSha, revertBranch, author);
    } catch (err) {
      app.log.error({ err }, "performRevert threw unexpectedly");
      return reply.status(500).send({ error: "Revert failed due to a server error" });
    }

    if (!result.ok) {
      return reply.status(409).send({
        error: "Revert could not be applied automatically because it conflicts with the base branch. Manual revert-conflict resolution isn't available yet.",
      });
    }

    const count = await prisma.pullRequest.count({ where: { repoId: repo.id } });
    const revertPr = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number: count + 1,
        title: `Revert "${pr.title}" (!${pr.number})`,
        description: `Reverts #${pr.number}.`,
        fromBranch: revertBranch,
        toBranch: pr.toBranch,
        state: "OPEN",
        authorId: userId,
      },
      include: { author: { select: { handle: true } } },
    });

    void notifySubscribers({ actorId: userId, repoId: repo.id, subjectType: "PULL_REQUEST", subjectId: revertPr.id, subjectTitle: revertPr.title, reason: "SUBSCRIBED" });

    // Ingest any snapshots reintroduced by the revert commit on the new branch.
    if (beforeSha && result.sha) {
      const repoPath = bareRepoPathFromKey(repo.storageKey);
      const repoId = repo.id;
      const afterSha = result.sha;
      setImmediate(() => {
        ingestCommitRange(repoId, repoPath, beforeSha, afterSha).catch(() => {});
      });
    }

    return reply.status(201).send({
      id: revertPr.id,
      number: revertPr.number,
      title: revertPr.title,
      description: revertPr.description,
      fromBranch: revertPr.fromBranch,
      toBranch: revertPr.toBranch,
      state: revertPr.state.toLowerCase(),
      mergedAt: null,
      author: revertPr.author.handle,
      createdAt: revertPr.createdAt.toISOString(),
      updatedAt: revertPr.updatedAt.toISOString(),
    });
  });

  // GET /repos/:handle/:name/pulls/:number/files
  app.get("/repos/:handle/:name/pulls/:number/files", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const pr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, number: Number(number) },
    });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const files = await getMergeBaseFileList(repo.storageKey, pr.toBranch, pr.fromBranch);
    return { files };
  });

  // GET /repos/:handle/:name/pulls/:number/diff
  app.get("/repos/:handle/:name/pulls/:number/diff", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { path: filePath } = request.query as { path?: string };

    if (!filePath) return reply.status(400).send({ error: "path query parameter is required" });

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const pr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, number: Number(number) },
    });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const files = await getMergeBaseDiff(repo.storageKey, pr.toBranch, pr.fromBranch, filePath);
    return { files };
  });

  // GET /repos/:handle/:name/pulls/:number/commits
  app.get("/repos/:handle/:name/pulls/:number/commits", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

    const pr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, number: Number(number) },
    });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const commits = await listMergeBaseCommits(repo.storageKey, pr.toBranch, pr.fromBranch);
    return { commits };
  });

  // PATCH /repos/:handle/:name/pulls/:number — close or reopen
  app.patch("/repos/:handle/:name/pulls/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    // Only author or repo owner can close/reopen
    if (pr.authorId !== userId && repo.ownerId !== userId)
      return reply.status(403).send({ error: "Only the author or owner can modify this PR" });

    const { state } = request.body as { state?: string };
    if (!state || !["open", "closed"].includes(state))
      return reply.status(400).send({ error: "state must be 'open' or 'closed'" });
    if (pr.state === "MERGED") return reply.status(409).send({ error: "Cannot change state of a merged PR" });

    const updated = await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { state: state === "open" ? "OPEN" : "CLOSED" },
    });

    return { id: updated.id, number: updated.number, state: updated.state.toLowerCase() };
  });
}
