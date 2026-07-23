import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listWorkflowRuns } from "../../../api";
import type { PullRequest, WorkflowRun } from "../../../types";
import {
  CheckStatusIcon,
  checkState,
  conclusionState,
  runStateLabel,
} from "../ci/ciShared";

/**
 * PR "Checks" section (issue #86). Shows every CheckRun for the PR head commit,
 * grouped by workflow run, with a link into the run detail / log view. Mounted in
 * PullDetail directly ABOVE the merge box. Renders nothing when the head has no
 * runs, so PRs on a CI-less repo are unaffected.
 *
 * While any check is still pending it polls every few seconds so a run's progress
 * appears live without a manual refresh.
 */
export function PRChecks({
  token,
  handle,
  repoName,
  pr,
  base,
}: {
  token: string;
  handle: string;
  repoName: string;
  pr: PullRequest;
  base: string;
}) {
  const headSha = pr.headSha ?? null;
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);

  const load = useCallback(async () => {
    if (!headSha) return;
    try {
      const { runs } = await listWorkflowRuns(token, handle, repoName, { sha: headSha });
      setRuns(runs);
    } catch {
      setRuns([]);
    }
  }, [token, handle, repoName, headSha]);

  useEffect(() => { void load(); }, [load]);

  // Poll while anything is still running/queued.
  const anyPending = (runs ?? []).some((r) => r.status !== "completed");
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  if (!headSha || !runs || runs.length === 0) return null;

  // Aggregate summary across all runs for the head commit.
  const agg = runs.reduce(
    (a, r) => ({
      total: a.total + r.summary.total,
      passing: a.passing + r.summary.passing,
      failing: a.failing + r.summary.failing,
      pending: a.pending + r.summary.pending,
    }),
    { total: 0, passing: 0, failing: 0, pending: 0 },
  );
  const overall = checkState(agg);

  const parts: string[] = [];
  if (agg.failing) parts.push(`${agg.failing} failing`);
  if (agg.pending) parts.push(`${agg.pending} pending`);
  if (agg.passing) parts.push(`${agg.passing} passing`);
  const summaryText = parts.join(", ") || "No checks";

  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas">
        <CheckStatusIcon state={overall} size={16} />
        <span className="text-fh-sm font-semibold text-fh-fg">Checks</span>
        <span className="text-fh-sm text-fh-fg-muted">— {summaryText}</span>
      </div>
      <ul className="divide-y divide-fh-border">
        {runs.map((run) =>
          run.checkRuns.map((check) => (
            <li key={check.id} className="flex items-center gap-3 px-4 py-2.5">
              <CheckStatusIcon state={conclusionState(check.status, check.conclusion)} size={15} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-fh-sm text-fh-fg">
                  <span className="font-medium">{check.jobName}</span>
                  <span className="text-fh-fg-subtle"> · {run.workflowName}</span>
                </p>
                <p className="text-fh-xs text-fh-fg-subtle">{runStateLabel({ status: check.status, conclusion: check.conclusion })}</p>
              </div>
              <Link
                to={`${base}/actions/runs/${run.id}`}
                className="shrink-0 text-fh-xs text-fh-accent-fg no-underline hover:underline"
              >
                Details
              </Link>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}
