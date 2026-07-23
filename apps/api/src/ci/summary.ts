/**
 * Roll a set of CheckRuns up into the counts the merge box, commit status dots,
 * and branch protection (#85) consume. Shared by the `/check-summary` contract
 * endpoint and the batch `/commit-statuses` endpoint so both agree exactly.
 */

export type CheckSummary = { total: number; passing: number; failing: number; pending: number };

export type CheckLike = { status: string; conclusion: string | null };

export function summarizeCheckRuns(checks: CheckLike[]): CheckSummary {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status !== "completed") {
      pending++;
    } else if (c.conclusion === "success") {
      passing++;
    } else {
      failing++; // completed with failure (or, defensively, a null conclusion)
    }
  }
  return { total: checks.length, passing, failing, pending };
}

export type CheckState = "success" | "failure" | "pending" | "none";

/** Single-glyph rollup: any pending → amber, else any failing → red, else green. */
export function rollupState(s: CheckSummary): CheckState {
  if (s.total === 0) return "none";
  if (s.pending > 0) return "pending";
  if (s.failing > 0) return "failure";
  return "success";
}
