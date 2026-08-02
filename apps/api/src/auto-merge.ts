import { prisma } from "./prisma.js";
import { resolveBranchSha } from "./git-utils.js";
import { computeReviewSummary } from "./review-summary.js";
import { evaluateMergeProtection } from "./branch-protection.js";
import { summarizeCheckRuns, type CheckSummary } from "./ci/summary.js";
import { executePullMerge } from "./pull-merge.js";
import { isMergeMethod } from "./merge-policy.js";

/**
 * Auto-merge (issue #119). A PR with `autoMergeMethod`/`autoMergeById` set is
 * ARMED: it merges itself, as the arming user, the moment its gates are all
 * green. There is deliberately NO polling loop — the evaluation runs only when
 * one of the two signals that can turn a gate green recomputes:
 *
 *   1. a review is submitted (routes/pr-comments.ts), which can clear the
 *      change-request gate and satisfy required approvals; and
 *   2. a CI run completes successfully (ci/runner.ts), which can turn the
 *      check summary green for the head commit.
 *
 * (Arming itself also evaluates once, so a PR whose gates are ALREADY green
 * merges immediately — otherwise no future signal would ever arrive.)
 *
 * The gates are the same ones the merge endpoint enforces, with NO overrides:
 * branch protection (hard gate, #85), zero active change requests (the soft
 * gate — auto-merge never overrides it), and a green check summary for the
 * head SHA (no failing, no pending; no runs at all counts as green, mirroring
 * the protection contract's "absent checks must not block").
 */

/** Minimal logger surface — the CI-runner call site has no Fastify logger. */
type LogLike = { error: (obj: unknown, msg?: string) => void };

export type AutoMergeResult =
  | { fired: true; sha: string }
  | { fired: false; reason: string };

/**
 * PR ids currently being evaluated/merged. Guards the firing against the two
 * signals racing each other in-process (review submit + CI completion landing
 * together): the second caller bails instead of double-merging. Cross-process
 * safety additionally rests on `performMerge`'s alreadyMerged detection.
 */
const inFlight = new Set<string>();

/** Check summary for a commit, straight from the DB (mirrors `/check-summary`): null when no runs exist. */
export async function checkSummaryForCommit(repoId: string, sha: string): Promise<CheckSummary | null> {
  const runs = await prisma.workflowRun.findMany({
    where: { repoId, commitSha: sha },
    select: { checkRuns: { select: { status: true, conclusion: true } } },
  });
  if (runs.length === 0) return null;
  return summarizeCheckRuns(runs.flatMap((r) => r.checkRuns));
}

/**
 * Evaluate every auto-merge gate for a PR at `headSha`. Returns the blocking
 * reasons (empty ⇒ ready to fire). Pure read — never mutates anything.
 */
export async function evaluateAutoMergeGates(
  pr: { id: string; toBranch: string },
  repoId: string,
  headSha: string | null,
): Promise<{ ready: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  const review = await computeReviewSummary(pr.id, headSha);
  if (review.changesRequested > 0) {
    reasons.push(`${review.changesRequested} active change request${review.changesRequested === 1 ? "" : "s"}`);
  }

  const checks = headSha ? await checkSummaryForCommit(repoId, headSha) : null;
  if (checks && (checks.failing > 0 || checks.pending > 0)) {
    reasons.push(`checks not green (${checks.failing} failing, ${checks.pending} pending)`);
  }

  // Branch protection (#85): the same hard gate the merge endpoint enforces.
  const rule = await prisma.protectedBranch.findFirst({ where: { repoId, branch: pr.toBranch } });
  if (rule && (rule.requiredApprovals > 0 || rule.requireGreenChecks)) {
    const status = evaluateMergeProtection(
      rule,
      pr.toBranch,
      { approvals: review.approvals, changesRequested: review.changesRequested },
      rule.requireGreenChecks ? checks : null,
    );
    if (status.blocked && status.reason) reasons.push(status.reason);
  }

  return { ready: reasons.length === 0, reasons };
}

/**
 * Evaluate an armed PR and merge it when every gate is green. Safe to call from
 * any signal site — a PR that is not armed, not open, or still gated is a no-op.
 * The in-flight guard makes concurrent signals fire the merge at most once.
 */
export async function maybeAutoMergePr(prId: string, log?: LogLike): Promise<AutoMergeResult> {
  if (inFlight.has(prId)) return { fired: false, reason: "already evaluating" };
  inFlight.add(prId);
  try {
    const pr = await prisma.pullRequest.findFirst({ where: { id: prId } });
    if (!pr || pr.state !== "OPEN") return { fired: false, reason: "not open" };
    if (!isMergeMethod(pr.autoMergeMethod) || !pr.autoMergeById) {
      return { fired: false, reason: "not armed" };
    }

    const repo = await prisma.repo.findFirst({ where: { id: pr.repoId } });
    if (!repo?.storageKey) return { fired: false, reason: "no git storage" };
    const storageKey = repo.storageKey;

    let headSha: string | null = null;
    try { headSha = await resolveBranchSha(storageKey, pr.fromBranch); } catch { headSha = null; }

    const gate = await evaluateAutoMergeGates(pr, repo.id, headSha);
    if (!gate.ready) return { fired: false, reason: gate.reasons.join("; ") };

    const outcome = await executePullMerge({
      repo: { id: repo.id, storageKey },
      pr: { id: pr.id, number: pr.number, title: pr.title, fromBranch: pr.fromBranch, toBranch: pr.toBranch },
      actorId: pr.autoMergeById,
      mergeMethod: pr.autoMergeMethod,
      auto: true,
      log,
    });
    if (outcome.status !== "merged") {
      // A conflict/error leaves the PR armed — a future head push may clear it,
      // and the merge box surfaces the conflict state to a human either way.
      return { fired: false, reason: outcome.status };
    }
    return { fired: true, sha: outcome.sha };
  } finally {
    inFlight.delete(prId);
  }
}

/**
 * CI-completion signal: a run at `commitSha` finished green — evaluate every
 * armed open PR whose head is that commit. App-less on purpose so the runner
 * can call it directly.
 */
export async function maybeAutoMergeForCommit(
  repoId: string,
  commitSha: string,
  log?: LogLike,
): Promise<void> {
  const armed = await prisma.pullRequest.findMany({
    where: { repoId, state: "OPEN", autoMergeMethod: { not: null } },
    select: { id: true, fromBranch: true },
  });
  if (armed.length === 0) return;

  const repo = await prisma.repo.findFirst({ where: { id: repoId } });
  if (!repo?.storageKey) return;
  const storageKey = repo.storageKey;

  for (const pr of armed) {
    let headSha: string | null = null;
    try { headSha = await resolveBranchSha(storageKey, pr.fromBranch); } catch { headSha = null; }
    // Only the run for the CURRENT head can complete the check gate — a run
    // finishing for a superseded commit must not merge newer, unchecked work.
    if (headSha !== commitSha) continue;
    await maybeAutoMergePr(pr.id, log);
  }
}
