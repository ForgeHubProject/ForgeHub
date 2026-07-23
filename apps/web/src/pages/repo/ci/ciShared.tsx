import { Icons, cx } from "../../../ui";
import type { CheckState, CheckSummary, CiConclusion, CiStatus, WorkflowRun } from "../../../types";

/** Single-glyph rollup: any pending → amber, else any failing → red, else green. */
export function checkState(s: CheckSummary): CheckState {
  if (s.total === 0) return "none";
  if (s.pending > 0) return "pending";
  if (s.failing > 0) return "failure";
  return "success";
}

/** Rollup for a single run from its status + conclusion. */
export function runState(run: Pick<WorkflowRun, "status" | "conclusion">): CheckState {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "failure") return "failure";
  if (run.conclusion === "success") return "success";
  return "none";
}

/** Rollup for one check run. */
export function conclusionState(status: CiStatus, conclusion: CiConclusion): CheckState {
  if (status !== "completed") return "pending";
  if (conclusion === "failure") return "failure";
  if (conclusion === "success") return "success";
  return "none";
}

const STATE_COLOR: Record<CheckState, string> = {
  success: "text-fh-success-fg",
  failure: "text-fh-danger-fg",
  pending: "text-fh-warning-fg",
  none: "text-fh-fg-subtle",
};

/**
 * The status glyph shared by commit rows, the code-tab head bar, the PR Checks
 * section, and the runs surface: green check / red x / amber (pulsing) dot /
 * neutral dot.
 */
export function CheckStatusIcon({
  state,
  size = 16,
  className,
  title,
}: {
  state: CheckState;
  size?: number;
  className?: string;
  title?: string;
}) {
  const color = STATE_COLOR[state];
  const label = title ?? STATE_LABEL[state];
  if (state === "success") {
    return <Icons.CheckIcon size={size} className={cx(color, className)} aria-label={label} />;
  }
  if (state === "failure") {
    return <Icons.XIcon size={size} className={cx(color, className)} aria-label={label} />;
  }
  // pending / none → a filled dot; pending pulses to read as "in progress".
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cx("inline-block rounded-full", color, state === "pending" && "animate-pulse", className)}
      style={{ width: size * 0.6, height: size * 0.6, backgroundColor: "currentColor" }}
    />
  );
}

export const STATE_LABEL: Record<CheckState, string> = {
  success: "All checks passed",
  failure: "Some checks failed",
  pending: "Checks in progress",
  none: "No checks",
};

/** Human label for a run's overall state (used in run rows / detail). */
export function runStateLabel(run: Pick<WorkflowRun, "status" | "conclusion">): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "In progress";
  return run.conclusion === "success" ? "Success" : run.conclusion === "failure" ? "Failure" : "Completed";
}

/** Short badge tone classes for a run/check state. */
export function stateBadgeClasses(state: CheckState): string {
  switch (state) {
    case "success":
      return "bg-fh-success-muted text-fh-success-fg";
    case "failure":
      return "bg-fh-danger-muted text-fh-danger-fg";
    case "pending":
      return "bg-fh-warning-muted text-fh-warning-fg";
    default:
      return "bg-fh-neutral-muted text-fh-fg-muted";
  }
}
