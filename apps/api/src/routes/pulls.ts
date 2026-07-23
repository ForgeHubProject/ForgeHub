import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { branchExists, defaultBranch, getMergeBaseDiff, getMergeBaseFileList, listMergeBaseCommits, performMerge, performRebaseMerge, performRevert, performSquashMerge, resolveBranchSha, type CommitAuthor, type MergeMethod } from "../git-utils.js";
import { notifySubscribers } from "../notifications-service.js";
import { recordEvent } from "../timeline-service.js";
import { emitRepoEvent } from "../webhook-service.js";
import { syncBodyReferences, closeIssuesForMergedPull } from "../references-service.js";
import { resolvePullRequestMerge, type MergeFileResolution } from "../merge/resolve-pull.js";
import { ingestCommitRange } from "../ingest.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import { computeReviewSummary } from "../review-summary.js";

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

/**
 * Soft review gate for merges. Blocks when an ACTIVE (non-stale)
 * CHANGES_REQUESTED review exists and the caller hasn't passed `override: true`.
 * Intentionally soft — any writer can override via the merge box's confirm step;
 * a hard required-approvals policy belongs to branch protection (issue #85).
 */
async function reviewGate(
  storageKey: string | null,
  prId: string,
  fromBranch: string,
  override: boolean,
): Promise<{ blocked: boolean; changesRequested: number }> {
  let headSha: string | null = null;
  if (storageKey) {
    try { headSha = await resolveBranchSha(storageKey, fromBranch); } catch { headSha = null; }
  }
  const summary = await computeReviewSummary(prId, headSha);
  return { blocked: summary.changesRequested > 0 && !override, changesRequested: summary.changesRequested };
}

function changesRequestedError(count: number): string {
  return `Changes were requested by ${count} reviewer${count === 1 ? "" : "s"}. `
    + "Resolve the requested changes, or merge with override to proceed anyway.";
}

export async function pullRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/pulls
  app.get("/repos/:handle/:name/pulls", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { state = "open", milestone } = request.query as { state?: string; milestone?: string };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const stateFilter =
      state === "closed" ? "CLOSED"
      : state === "merged" ? "MERGED"
      : state === "all" ? undefined
      : "OPEN";

    // `?milestone=` accepts a title, "none" (unassociated), or "*" (any) — matching
    // the issue-list milestone filter (#83).
    const milestoneWhere =
      milestone === undefined ? {}
      : milestone === "none" ? { milestoneId: null }
      : milestone === "*" ? { milestoneId: { not: null } }
      : { milestone: { title: milestone } };

    const pulls = await prisma.pullRequest.findMany({
      where: { repoId: repo.id, ...(stateFilter ? { state: stateFilter } : {}), ...milestoneWhere },
      orderBy: { number: "desc" },
      include: {
        author: { select: { handle: true, displayName: true } },
        milestone: { select: { id: true, number: true, title: true, state: true } },
      },
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
        milestone: p.milestone
          ? { id: p.milestone.id, number: p.milestone.number, title: p.milestone.title, state: p.milestone.state.toLowerCase() }
          : null,
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
    void emitRepoEvent({
      repoId: repo.id, event: "pull_request", action: "opened", senderId: userId,
      subject: { number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch, state: "open" },
    });

    // Parse the description: cross-refs, closing keywords (closed on merge), mentions.
    await syncBodyReferences({
      repo, actorId: userId,
      source: { type: "PULL_REQUEST", id: pr.id },
      container: { subjectType: "PULL_REQUEST", id: pr.id, number: pr.number, title: pr.title },
      body: pr.description,
    }).catch((err) => request.log.error({ err }, "syncBodyReferences (pull create)"));

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
      include: {
        author: { select: { handle: true, displayName: true } },
        milestone: { select: { id: true, number: true, title: true, state: true } },
      },
    });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    // Resolve the head SHA (drives mergeable + review staleness) and compute the
    // review summary that the merge box renders and gates on.
    let mergeable: boolean | null = null;
    let headSha: string | null = null;
    if (repo.storageKey) {
      try {
        headSha = await resolveBranchSha(repo.storageKey, pr.fromBranch);
        if (pr.state === "OPEN") {
          const toSha = await resolveBranchSha(repo.storageKey, pr.toBranch);
          mergeable = !!(headSha && toSha);
        }
      } catch { mergeable = pr.state === "OPEN" ? false : null; }
    }

    const reviewSummary = await computeReviewSummary(pr.id, headSha);

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      description: pr.description,
      fromBranch: pr.fromBranch,
      toBranch: pr.toBranch,
      state: pr.state.toLowerCase(),
      mergeable,
      headSha,
      reviewSummary,
      mergedAt: pr.mergedAt?.toISOString() ?? null,
      mergeMethod: pr.mergeMethod ?? null,
      author: pr.author.handle,
      milestone: pr.milestone
        ? { id: pr.milestone.id, number: pr.milestone.number, title: pr.milestone.title, state: pr.milestone.state.toLowerCase() }
        : null,
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

    const { commitMessage, mergeMethod: rawMethod, override } = (request.body ?? {}) as { commitMessage?: string; mergeMethod?: string; override?: boolean };
    const mergeMethod: MergeMethod = (rawMethod ?? "merge") as MergeMethod;
    if (!MERGE_METHODS.includes(mergeMethod)) {
      return reply.status(400).send({ error: `mergeMethod must be one of: ${MERGE_METHODS.join(", ")}` });
    }

    // Soft review gate: block on active change requests unless overridden.
    const gate = await reviewGate(repo.storageKey, pr.id, pr.fromBranch, override === true);
    if (gate.blocked) {
      return reply.status(409).send({ error: changesRequestedError(gate.changesRequested), changesRequested: true });
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

    await recordEvent({ repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number, kind: "merged", actorId: userId, data: { sha: result.sha } })
      .catch((err) => request.log.error({ err }, "recordEvent merged"));
    void emitRepoEvent({
      repoId: repo.id, event: "pull_request", action: "merged", senderId: userId,
      subject: { number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch, state: "merged", mergeCommitSha: result.sha },
    });
    await closeIssuesForMergedPull({ repoId: repo.id, prId: pr.id, prNumber: pr.number, mergerId: userId })
      .catch((err) => request.log.error({ err }, "closeIssuesForMergedPull"));

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
      override?: boolean;
    };

    const hasFiles = Array.isArray(body.files) && body.files.length > 0;
    const strategy = body.strategy;
    if (!hasFiles && strategy !== "ours" && strategy !== "theirs") {
      return reply.status(400).send({
        error: "Provide strategy ('ours' | 'theirs') or a non-empty files resolution list",
      });
    }

    // Soft review gate: block on active change requests unless overridden.
    const gate = await reviewGate(repo.storageKey, pr.id, pr.fromBranch, body.override === true);
    if (gate.blocked) {
      return reply.status(409).send({ error: changesRequestedError(gate.changesRequested), changesRequested: true });
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

    await recordEvent({ repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number, kind: "merged", actorId: userId, data: { sha: result.sha } })
      .catch((err) => request.log.error({ err }, "recordEvent merged"));
    void emitRepoEvent({
      repoId: repo.id, event: "pull_request", action: "merged", senderId: userId,
      subject: { number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch, state: "merged", mergeCommitSha: result.sha },
    });
    await closeIssuesForMergedPull({ repoId: repo.id, prId: pr.id, prNumber: pr.number, mergerId: userId })
      .catch((err) => request.log.error({ err }, "closeIssuesForMergedPull"));

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

  // PATCH /repos/:handle/:name/pulls/:number — close/reopen and/or set milestone
  app.patch("/repos/:handle/:name/pulls/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const { state, milestoneId } = request.body as { state?: string; milestoneId?: string | null };

    // At least one recognized field is required.
    if (state === undefined && milestoneId === undefined) {
      return reply.status(400).send({ error: "state must be 'open' or 'closed'" });
    }

    // ── State change: author or repo owner ────────────────────────────────────────
    if (state !== undefined) {
      if (pr.authorId !== userId && repo.ownerId !== userId)
        return reply.status(403).send({ error: "Only the author or owner can modify this PR" });
      if (!["open", "closed"].includes(state))
        return reply.status(400).send({ error: "state must be 'open' or 'closed'" });
      if (pr.state === "MERGED") return reply.status(409).send({ error: "Cannot change state of a merged PR" });
    }

    // ── Milestone association (#83): writer-gated, milestone must belong to the repo ─
    let nextMilestoneId: string | null | undefined;
    if (milestoneId !== undefined) {
      if (!canWrite(repo, userId)) {
        return reply.status(403).send({ error: "Write access is required to set a milestone" });
      }
      if (milestoneId) {
        const ms = await prisma.milestone.findFirst({ where: { id: milestoneId, repoId: repo.id }, select: { id: true } });
        if (!ms) return reply.status(404).send({ error: "Milestone not found" });
        nextMilestoneId = ms.id;
      } else {
        nextMilestoneId = null;
      }
    }

    const updated = await prisma.pullRequest.update({
      where: { id: pr.id },
      data: {
        ...(state !== undefined ? { state: state === "open" ? "OPEN" : "CLOSED" } : {}),
        ...(nextMilestoneId !== undefined ? { milestoneId: nextMilestoneId } : {}),
      },
      include: { milestone: { select: { id: true, number: true, title: true, state: true } } },
    });

    if (state !== undefined && updated.state !== pr.state) {
      await recordEvent({
        repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
        kind: updated.state === "CLOSED" ? "closed" : "reopened", actorId: userId,
      }).catch((err) => request.log.error({ err }, "recordEvent pull state"));
      void emitRepoEvent({
        repoId: repo.id, event: "pull_request", action: updated.state === "CLOSED" ? "closed" : "reopened", senderId: userId,
        subject: { number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch, state: updated.state.toLowerCase() },
      });
    }
    if (nextMilestoneId !== undefined && updated.milestoneId !== pr.milestoneId) {
      if (updated.milestone) {
        await recordEvent({
          repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
          kind: "milestoned", actorId: userId,
          data: { milestone: { title: updated.milestone.title, number: updated.milestone.number } },
        }).catch((err) => request.log.error({ err }, "recordEvent pull milestoned"));
      } else if (pr.milestoneId) {
        const prev = await prisma.milestone.findUnique({ where: { id: pr.milestoneId }, select: { title: true, number: true } });
        await recordEvent({
          repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
          kind: "demilestoned", actorId: userId,
          data: { milestone: prev ? { title: prev.title, number: prev.number } : undefined },
        }).catch((err) => request.log.error({ err }, "recordEvent pull demilestoned"));
      }
    }

    return {
      id: updated.id,
      number: updated.number,
      state: updated.state.toLowerCase(),
      milestone: updated.milestone
        ? { id: updated.milestone.id, number: updated.milestone.number, title: updated.milestone.title, state: updated.milestone.state.toLowerCase() }
        : null,
    };
  });
}
