import type { FastifyInstance } from "fastify";
import { prisma } from "./prisma.js";
import { bareRepoPathFromKey } from "./git-storage.js";
import { writeProtectionConfig } from "./git-hooks.js";

/**
 * Branch protection (issue #85).
 *
 * Two enforcement paths:
 *  (a) the git transport — a pre-receive hook installed in each bare repo (see
 *      `git-hooks.ts`) blocks direct pushes / force-pushes / deletions to
 *      protected branches; and
 *  (b) the merge endpoints — `requiredApprovals` and `requireGreenChecks` are a
 *      HARD gate (the soft change-request override is NOT honored for these).
 *
 * The hook reads its rules from a plain-text `forgehub-protection` file next to
 * the bare repo's git dir, regenerated from the database on every HTTP push
 * (the DB is the source of truth — the file is a per-push snapshot). Server-side
 * merges push to the bare repo through local git and would otherwise trip the
 * hook, so those pushes set `FORGEHUB_INTERNAL_PUSH=1` to bypass it.
 */

/** Regenerate a repo's pre-receive rules file from the database (source of truth). */
export async function syncProtectionConfig(repoId: string, storageKey: string): Promise<void> {
  const rows = await prisma.protectedBranch.findMany({
    where: { repoId },
    select: { branch: true, requirePullRequest: true, blockForcePush: true },
  });
  await writeProtectionConfig(bareRepoPathFromKey(storageKey), rows);
}

// ── merge endpoints: approvals + green-checks hard gate ───────────────────────

export type CheckSummary = { total: number; passing: number; failing: number; pending: number };

export type ProtectionRuleRow = {
  requirePullRequest: boolean;
  requiredApprovals: number;
  requireGreenChecks: boolean;
  blockForcePush: boolean;
};

/** One active merge-gate rule, for the merge box's protection panel. */
export type ProtectionRuleState = {
  key: "approvals" | "checks";
  label: string;
  satisfied: boolean;
  detail: string;
};

export type ProtectionMergeStatus = {
  branch: string;
  requiredApprovals: number;
  requireGreenChecks: boolean;
  approvals: number;
  changesRequested: number;
  checks: CheckSummary | null;
  /** Only the ACTIVE merge-gate rules (approvals when N>0, checks when required). */
  rules: ProtectionRuleState[];
  blocked: boolean;
  /** First blocking reason — the message a 409 carries. */
  reason: string | null;
};

/**
 * Fetch the check-summary for a head SHA in-process. The endpoint is owned by
 * the CI epic; per the contract, a 404 (or any non-200 / malformed body) means
 * "no checks configured" and MUST NOT block — we return null.
 */
export async function getCheckSummary(
  app: FastifyInstance,
  handle: string,
  name: string,
  sha: string,
  authorization?: string,
): Promise<CheckSummary | null> {
  if (!sha) return null;
  try {
    const res = await app.inject({
      method: "GET",
      url: `/repos/${encodeURIComponent(handle)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}/check-summary`,
      ...(authorization ? { headers: { authorization } } : {}),
    });
    if (res.statusCode !== 200) return null;
    const body = res.json() as Partial<CheckSummary> | null;
    if (!body || typeof body.total !== "number") return null;
    return {
      total: body.total,
      passing: body.passing ?? 0,
      failing: body.failing ?? 0,
      pending: body.pending ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Pure evaluation of the merge-time protection rules. `review` carries the
 * non-stale approval / change-request counts (review-summary semantics);
 * `checks` is null when no checks are configured (never blocks).
 */
export function evaluateMergeProtection(
  rule: ProtectionRuleRow,
  branch: string,
  review: { approvals: number; changesRequested: number },
  checks: CheckSummary | null,
): ProtectionMergeStatus {
  const rules: ProtectionRuleState[] = [];
  let reason: string | null = null;

  if (rule.requiredApprovals > 0) {
    const enough = review.approvals >= rule.requiredApprovals;
    const noBlocks = review.changesRequested === 0;
    const satisfied = enough && noBlocks;
    const detail = !noBlocks
      ? `${review.changesRequested} reviewer${review.changesRequested === 1 ? "" : "s"} requested changes`
      : `${review.approvals} of ${rule.requiredApprovals} approval${rule.requiredApprovals === 1 ? "" : "s"}`;
    rules.push({
      key: "approvals",
      label: `Requires ${rule.requiredApprovals} approving review${rule.requiredApprovals === 1 ? "" : "s"}`,
      satisfied,
      detail,
    });
    if (!satisfied && reason === null) {
      reason = !noBlocks
        ? `Branch protection: "${branch}" has ${review.changesRequested} active change request${review.changesRequested === 1 ? "" : "s"} that must be resolved before merging.`
        : `Branch protection: "${branch}" requires ${rule.requiredApprovals} approving review${rule.requiredApprovals === 1 ? "" : "s"}, but only ${review.approvals} non-stale approval${review.approvals === 1 ? "" : "s"} ${review.approvals === 1 ? "is" : "are"} present.`;
    }
  }

  if (rule.requireGreenChecks) {
    if (checks === null) {
      rules.push({
        key: "checks",
        label: "Requires status checks to pass",
        satisfied: true,
        detail: "No checks configured",
      });
    } else {
      const satisfied = checks.failing === 0 && checks.pending === 0;
      const detail = satisfied
        ? `${checks.passing}/${checks.total} check${checks.total === 1 ? "" : "s"} passing`
        : `${checks.failing} failing, ${checks.pending} pending`;
      rules.push({ key: "checks", label: "Requires status checks to pass", satisfied, detail });
      if (!satisfied && reason === null) {
        reason = `Branch protection: "${branch}" requires all status checks to pass (${checks.failing} failing, ${checks.pending} pending).`;
      }
    }
  }

  return {
    branch,
    requiredApprovals: rule.requiredApprovals,
    requireGreenChecks: rule.requireGreenChecks,
    approvals: review.approvals,
    changesRequested: review.changesRequested,
    checks,
    rules,
    blocked: reason !== null,
    reason,
  };
}
