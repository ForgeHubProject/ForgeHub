import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { branchExists, defaultBranch, getMergeBaseDiff, getMergeBaseFileList, listMergeBaseCommits, performRevert, resolveBranchSha, type MergeMethod } from "../git-utils.js";
import { notifySubscribers } from "../notifications-service.js";
import { recordEvent } from "../timeline-service.js";
import { emitRepoEvent } from "../webhook-service.js";
import { resolveMilestoneFilter } from "../milestone-filter.js";
import { syncBodyReferences, closeIssuesForMergedPull } from "../references-service.js";
import { resolvePullRequestMerge, type MergeFileResolution } from "../merge/resolve-pull.js";
import { ingestCommitRange } from "../ingest.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import { computeReviewSummary } from "../review-summary.js";
import { triggerWorkflowsForPrOpen } from "../ci/trigger.js";
import { emitPushEvents, ZERO_SHA } from "../push-events.js";
import { evaluateMergeProtection, getCheckSummary, type ProtectionMergeStatus } from "../branch-protection.js";
import { executePullMerge, resolveActorIdentity } from "../pull-merge.js";
import { maybeAutoMergePr } from "../auto-merge.js";
import { isMergeMethod, repoMergePolicy } from "../merge-policy.js";
import { reactionRollupFor, reactionRollups, emptyRollup } from "../reactions-service.js";

/**
 * The auto-merge fields of a PR payload: null until armed, and null again once
 * the PR leaves OPEN — auto-merge can only fire on an open PR, so reporting an
 * armed intent on a merged/closed one would be stale (a merge and a close both
 * clear the columns; the state check also covers rows written before that).
 */
async function autoMergePayload(pr: {
  state?: string;
  autoMergeMethod?: string | null;
  autoMergeById?: string | null;
}): Promise<{ method: string; by: string } | null> {
  if (pr.state !== undefined && pr.state !== "OPEN") return null;
  if (!pr.autoMergeMethod || !pr.autoMergeById) return null;
  const user = await prisma.user.findUnique({
    where: { id: pr.autoMergeById },
    select: { handle: true },
  });
  return { method: pr.autoMergeMethod, by: user?.handle ?? "ghost" };
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

/**
 * HARD branch-protection gate for the merge endpoints (issue #85). Returns the
 * protection status when the target branch is protected with merge-gate rules
 * (`requiredApprovals` / `requireGreenChecks`), else null. `override` is
 * intentionally NOT accepted — protection is not overridable in v0 (an admin
 * bypass setting is a follow-up). `headSha` drives both review staleness and the
 * check-summary lookup; `authorization` is forwarded so the in-process
 * check-summary call sees the same actor (private repos).
 */
async function loadMergeProtection(
  app: FastifyInstance,
  repo: { id: string },
  handle: string,
  name: string,
  pr: { id: string; toBranch: string },
  headSha: string | null,
  authorization?: string,
): Promise<ProtectionMergeStatus | null> {
  const rule = await prisma.protectedBranch.findFirst({ where: { repoId: repo.id, branch: pr.toBranch } });
  if (!rule) return null;
  const needsApprovals = rule.requiredApprovals > 0;
  const needsChecks = rule.requireGreenChecks;
  if (!needsApprovals && !needsChecks) return null; // protected, but no merge-gate rules

  const review = needsApprovals
    ? await computeReviewSummary(pr.id, headSha)
    : { approvals: 0, changesRequested: 0 };
  const checks = needsChecks
    ? await getCheckSummary(app, handle, name, headSha ?? "", authorization)
    : null;

  return evaluateMergeProtection(
    rule,
    pr.toBranch,
    { approvals: review.approvals, changesRequested: review.changesRequested },
    checks,
  );
}

export async function pullRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to open / merge / revert / change the state of
  // a pull request (issue #87). Session/JWT auth is unscoped and no-ops this
  // guard. Route bodies keep their own writer/author/owner checks; this only
  // closes the hole where a `repo:read` PAT could mutate PRs.
  const write = app.requireScope("repo:write");

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

    // `?milestone=` accepts a milestone NUMBER or TITLE, plus "none" (unassociated)
    // and "*" (any milestone) — matching the issue-list filter. The web serializes
    // by number while the original API took a title, so the shared resolver accepts
    // either (wave-A D2).
    const milestoneWhere = await resolveMilestoneFilter(repo.id, milestone);

    const pulls = await prisma.pullRequest.findMany({
      where: { repoId: repo.id, ...(stateFilter ? { state: stateFilter } : {}), ...milestoneWhere },
      orderBy: { number: "desc" },
      include: {
        author: { select: { handle: true, displayName: true } },
        milestone: { select: { id: true, number: true, title: true, state: true } },
      },
    });

    // Reactions ride along, batched: ONE grouped query for the whole page (#90).
    const rollups = await reactionRollups("PULL_REQUEST", pulls.map((p) => p.id), userId);

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
        ...(rollups.get(p.id) ?? emptyRollup()),
      })),
    };
  });

  // POST /repos/:handle/:name/pulls
  app.post("/repos/:handle/:name/pulls", { preHandler: [app.authenticate, write] }, async (request, reply) => {
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

    // Actions-style CI (issue #86): enqueue a `pull_request` run at the new PR's
    // head. No-op unless FORGEHUB_CI=1. Best-effort — never fails PR creation.
    if (repo.storageKey) {
      const storageKey = repo.storageKey;
      void resolveBranchSha(storageKey, fromBranch).then((headSha) => {
        if (headSha) return triggerWorkflowsForPrOpen(repo.id, storageKey, pr.id, fromBranch, headSha, pr.toBranch);
      }).catch((err) => request.log.error({ err }, "PR-open CI trigger failed"));
    }

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

    // Branch-protection status for the merge box (issue #85): the active
    // merge-gate rules and whether each is satisfied. Null when the target
    // branch isn't protected or carries no merge-gate rules.
    const protection = pr.state === "OPEN"
      ? await loadMergeProtection(app, repo, handle, name, pr, headSha, request.headers.authorization)
      : null;

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
      protection,
      // Owner merge policy (issue #119): which methods the merge box may offer.
      mergePolicy: repoMergePolicy(repo),
      // Armed auto-merge intent (issue #119); null when not armed.
      autoMerge: await autoMergePayload(pr),
      mergedAt: pr.mergedAt?.toISOString() ?? null,
      mergeMethod: pr.mergeMethod ?? null,
      author: pr.author.handle,
      milestone: pr.milestone
        ? { id: pr.milestone.id, number: pr.milestone.number, title: pr.milestone.title, state: pr.milestone.state.toLowerCase() }
        : null,
      createdAt: pr.createdAt.toISOString(),
      updatedAt: pr.updatedAt.toISOString(),
      // Emoji reactions on the PR body (#90): grouped counts + viewer state.
      ...(await reactionRollupFor("PULL_REQUEST", pr.id, userId)),
    };
  });

  // POST /repos/:handle/:name/pulls/:number/merge
  app.post("/repos/:handle/:name/pulls/:number/merge", { preHandler: [app.authenticate, write] }, async (request, reply) => {
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
    // The repo's merge policy (issue #119) picks the fallback method and gates
    // which methods this endpoint accepts at all.
    const policy = repoMergePolicy(repo);
    const mergeMethod: MergeMethod = (rawMethod ?? policy.defaultMethod) as MergeMethod;
    if (!isMergeMethod(mergeMethod)) {
      return reply.status(400).send({ error: "mergeMethod must be one of: merge, squash, rebase" });
    }
    if (!policy.allowedMethods.includes(mergeMethod)) {
      return reply.status(400).send({
        error: `mergeMethod '${mergeMethod}' is not allowed for this repository (allowed: ${policy.allowedMethods.join(", ")})`,
      });
    }

    // Resolve the head SHA once — drives review staleness AND the check-summary lookup.
    let headSha: string | null = null;
    try { headSha = await resolveBranchSha(repo.storageKey, pr.fromBranch); } catch { headSha = null; }

    // HARD branch-protection gate (issue #85): required approvals / green checks.
    // Override is NOT honored here — protection applies to everyone, owner included.
    const protection = await loadMergeProtection(app, repo, handle, name, pr, headSha, request.headers.authorization);
    if (protection?.blocked) {
      return reply.status(409).send({ error: protection.reason, protection: true });
    }

    // Soft review gate: block on active change requests unless overridden.
    const gate = await reviewGate(repo.storageKey, pr.id, pr.fromBranch, override === true);
    if (gate.blocked) {
      return reply.status(409).send({ error: changesRequestedError(gate.changesRequested), changesRequested: true });
    }

    // Execution + merge side effects live in the shared executor (issue #119),
    // so the interactive endpoint and auto-merge can never drift apart.
    const outcome = await executePullMerge({
      repo: { id: repo.id, storageKey: repo.storageKey },
      pr: { id: pr.id, number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch },
      actorId: userId,
      mergeMethod,
      commitMessage,
      log: request.log,
    });

    if (outcome.status === "error") {
      return reply.status(500).send({ error: "Merge failed due to a server error" });
    }
    if (outcome.status === "alreadyMerged") {
      return reply.status(409).send({ error: "Branch is already merged" });
    }
    if (outcome.status === "conflict") {
      const conflictError =
        mergeMethod === "rebase" ? "Rebase conflict — commits could not be replayed cleanly onto the base branch"
        : mergeMethod === "squash" ? "Squash conflict — cannot auto-merge"
        : "Merge conflict — cannot auto-merge";
      return reply.status(409).send({ error: conflictError, resolvable: true });
    }

    return { merged: true, sha: outcome.sha, method: mergeMethod };
  });

  // POST /repos/:handle/:name/pulls/:number/auto-merge — arm auto-merge (issue #119)
  //
  // Records the intent (method + arming user) and immediately evaluates the
  // gates once: a PR whose review gate and check summary are ALREADY green
  // merges on the spot (there would be no later signal to fire on). Otherwise
  // the PR stays armed and fires from the review-submit / CI-completion hooks.
  app.post("/repos/:handle/:name/pulls/:number/auto-merge", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
    if (!repo.storageKey) return reply.status(400).send({ error: "No git storage" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });
    if (pr.state !== "OPEN") return reply.status(409).send({ error: `Pull request is ${pr.state.toLowerCase()}` });

    const policy = repoMergePolicy(repo);
    const { mergeMethod: rawMethod } = (request.body ?? {}) as { mergeMethod?: string };
    const mergeMethod: MergeMethod = (rawMethod ?? policy.defaultMethod) as MergeMethod;
    if (!isMergeMethod(mergeMethod)) {
      return reply.status(400).send({ error: "mergeMethod must be one of: merge, squash, rebase" });
    }
    if (!policy.allowedMethods.includes(mergeMethod)) {
      return reply.status(400).send({
        error: `mergeMethod '${mergeMethod}' is not allowed for this repository (allowed: ${policy.allowedMethods.join(", ")})`,
      });
    }

    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { autoMergeMethod: mergeMethod, autoMergeById: userId },
    });
    await recordEvent({
      repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
      kind: "auto_merge_enabled", actorId: userId, data: { method: mergeMethod },
    }).catch((err) => request.log.error({ err }, "recordEvent auto_merge_enabled"));

    const result = await maybeAutoMergePr(pr.id, request.log);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true } });
    return {
      autoMerge: { method: mergeMethod, by: user?.handle ?? "ghost" },
      merged: result.fired,
      ...(result.fired ? { sha: result.sha } : {}),
    };
  });

  // DELETE /repos/:handle/:name/pulls/:number/auto-merge — disarm auto-merge.
  // Any writer may cancel (same audience that could merge/arm), not just the armer.
  app.delete("/repos/:handle/:name/pulls/:number/auto-merge", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });
    if (!pr.autoMergeMethod) return reply.status(409).send({ error: "Auto-merge is not enabled on this pull request" });

    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { autoMergeMethod: null, autoMergeById: null },
    });
    await recordEvent({
      repoId: repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
      kind: "auto_merge_disabled", actorId: userId,
    }).catch((err) => request.log.error({ err }, "recordEvent auto_merge_disabled"));

    return { autoMerge: null };
  });

  // POST /repos/:handle/:name/pulls/:number/merge-resolve — resolve a conflict with ours/theirs
  app.post("/repos/:handle/:name/pulls/:number/merge-resolve", { preHandler: [app.authenticate, write] }, async (request, reply) => {
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

    // Resolve the head SHA once (review staleness + check-summary lookup).
    let headSha: string | null = null;
    try { headSha = await resolveBranchSha(repo.storageKey, pr.fromBranch); } catch { headSha = null; }

    // HARD branch-protection gate (issue #85). Override is NOT honored here.
    const protection = await loadMergeProtection(app, repo, handle, name, pr, headSha, request.headers.authorization);
    if (protection?.blocked) {
      return reply.status(409).send({ error: protection.reason, protection: true });
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
    // Target branch tip moved via an internal merge push — mirror a client push
    // to `toBranch` with a `push` webhook + push CI (issues #86/#87).
    emitPushEvents(repo.id, repo.storageKey, userId, [
      { branch: pr.toBranch, oldSha: beforeSha ?? ZERO_SHA, newSha: result.sha },
    ]);
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
  app.post("/repos/:handle/:name/pulls/:number/revert", { preHandler: [app.authenticate, write] }, async (request, reply) => {
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

    // The revert branch was created via an internal direct-to-bare push (bypasses
    // post-receive), so fire the same `push` webhook + push CI a client creating
    // `revert-pr-N` would — a new branch, hence a zero before-sha (issues #86/#87).
    emitPushEvents(repo.id, repo.storageKey, userId, [
      { branch: revertBranch, oldSha: ZERO_SHA, newSha: result.sha },
    ]);

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

    // Per-user viewed state (issue #119): stamp each entry for the signed-in
    // viewer. Anonymous readers get plain `viewed: false` everywhere.
    let viewedPaths = new Set<string>();
    if (userId && files.length > 0) {
      const rows = await prisma.pullRequestFileView.findMany({
        where: { pullRequestId: pr.id, userId },
        select: { filePath: true },
      });
      viewedPaths = new Set(rows.map((r) => r.filePath));
    }

    return { files: files.map((f) => ({ ...f, viewed: viewedPaths.has(f.path) })) };
  });

  // PUT /repos/:handle/:name/pulls/:number/viewed-files — set one file's viewed
  // state for the CALLING user (issue #119). Pure per-user bookkeeping: any
  // authenticated reader may track their own progress; nothing is gated on it.
  app.put("/repos/:handle/:name/pulls/:number/viewed-files", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const pr = await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!pr) return reply.status(404).send({ error: "Pull request not found" });

    const { path: filePath, viewed } = (request.body ?? {}) as { path?: string; viewed?: boolean };
    if (!filePath?.trim()) return reply.status(400).send({ error: "path is required" });
    if (typeof viewed !== "boolean") return reply.status(400).send({ error: "viewed must be a boolean" });

    const key = { pullRequestId: pr.id, userId, filePath: filePath.trim() };
    if (viewed) {
      await prisma.pullRequestFileView.upsert({
        where: { pullRequestId_userId_filePath: key },
        create: key,
        update: { viewedAt: new Date() },
      });
    } else {
      await prisma.pullRequestFileView.deleteMany({ where: key });
    }

    return { path: key.filePath, viewed };
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
  app.patch("/repos/:handle/:name/pulls/:number", { preHandler: [app.authenticate, write] }, async (request, reply) => {
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
        // Closing disarms auto-merge (issue #119) — a later reopen must never
        // resurrect a stale intent and merge behind everyone's back.
        ...(state === "closed" ? { autoMergeMethod: null, autoMergeById: null } : {}),
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
