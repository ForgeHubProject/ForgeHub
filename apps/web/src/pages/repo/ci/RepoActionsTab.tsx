import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getCheckLog, getWorkflowRun, listWorkflowRuns } from "../../../api";
import type { CheckRun, WorkflowRun } from "../../../types";
import { EmptyState, Icons, RelativeTime, Skeleton, cx } from "../../../ui";
import {
  CheckStatusIcon,
  conclusionState,
  runState,
  runStateLabel,
  stateBadgeClasses,
} from "./ciShared";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  splat: string;
};

// ─── Runs list ──────────────────────────────────────────────────────────────────

function RunsList({ token, handle, repoName, base }: Props & { base: string }) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { runs } = await listWorkflowRuns(token, handle, repoName);
      setRuns(runs);
    } catch {
      setError(true);
      setRuns([]);
    }
  }, [token, handle, repoName]);

  useEffect(() => { void load(); }, [load]);

  const anyPending = (runs ?? []).some((r) => r.status !== "completed");
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  if (runs === null) {
    return (
      <div className="divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton variant="circle" width={18} height={18} />
            <Skeleton className="h-4 flex-1 rounded" />
            <Skeleton width={64} height={16} className="rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-fh-border bg-fh-surface">
        <EmptyState
          icon={<Icons.CheckIcon size={26} />}
          title={error ? "Couldn't load workflow runs" : "No workflow runs yet"}
          description={
            error
              ? "This repository may not have CI enabled."
              : "Add a .forgehub/workflows/*.yml file and push to trigger your first run."
          }
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-fh-sm text-fh-fg-muted">
        <Icons.CheckIcon size={16} className="text-fh-fg-subtle" />
        <span className="font-semibold text-fh-fg">Workflow runs</span>
      </div>
      <ul className="divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface overflow-hidden">
        {runs.map((run) => (
          <li key={run.id} className="flex items-center gap-3 px-4 py-3 hover:bg-fh-surface-muted/50 transition-colors">
            <CheckStatusIcon state={runState(run)} size={16} />
            <div className="min-w-0 flex-1">
              <Link
                to={`${base}/actions/runs/${run.id}`}
                className="text-fh-sm font-semibold text-fh-fg no-underline hover:text-fh-accent-fg"
              >
                {run.workflowName}
              </Link>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fh-xs text-fh-fg-muted">
                <span className="rounded bg-fh-neutral-muted px-1.5 py-0.5 font-medium">{run.trigger}</span>
                {run.ref && <span className="font-mono">{run.ref}</span>}
                <span className="font-mono text-fh-fg-subtle">{run.shortSha}</span>
                <span aria-hidden="true">·</span>
                <RelativeTime date={run.createdAt} />
              </p>
            </div>
            <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-fh-xs font-medium", stateBadgeClasses(runState(run)))}>
              {runStateLabel(run)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Run detail (+ monospace logs) ────────────────────────────────────────────────

function JobLog({ token, handle, repoName, runId, check }: {
  token: string; handle: string; repoName: string; runId: string; check: CheckRun;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || log !== null || !check.hasLog) return;
    setLoading(true);
    getCheckLog(token, handle, repoName, runId, check.id)
      .then(setLog)
      .catch(() => setLog("(log unavailable)"))
      .finally(() => setLoading(false));
  }, [open, log, check.hasLog, token, handle, repoName, runId, check.id]);

  return (
    <div className="border border-fh-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 bg-fh-surface px-3 py-2.5 text-left hover:bg-fh-surface-muted/60 transition-colors"
      >
        <Icons.ChevronDownIcon size={14} className={cx("shrink-0 text-fh-fg-subtle transition-transform", !open && "-rotate-90")} />
        <CheckStatusIcon state={conclusionState(check.status, check.conclusion)} size={15} />
        <span className="min-w-0 flex-1 truncate text-fh-sm font-medium text-fh-fg">{check.jobName}</span>
        <span className="shrink-0 text-fh-xs text-fh-fg-muted">{runStateLabel({ status: check.status, conclusion: check.conclusion })}</span>
      </button>
      {open && (
        <div className="border-t border-fh-border">
          {loading ? (
            <div className="p-3"><Skeleton className="h-24 w-full rounded" /></div>
          ) : (
            <pre className="max-h-[28rem] overflow-auto bg-fh-surface-muted px-3 py-2.5 font-mono text-fh-xs leading-relaxed text-fh-fg whitespace-pre">
              {log && log.length > 0 ? log : "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function RunDetail({ token, handle, repoName, id, base }: Props & { id: string; base: string }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await getWorkflowRun(token, handle, repoName, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not found");
    }
  }, [token, handle, repoName, id]);

  useEffect(() => { void load(); }, [load]);

  const pending = run != null && run.status !== "completed";
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [pending, load]);

  const backLink = (
    <Link
      to={`${base}/actions`}
      className="mb-4 inline-flex items-center gap-1.5 text-fh-sm text-fh-fg-muted no-underline hover:text-fh-accent-fg"
    >
      <Icons.ChevronDownIcon size={14} className="rotate-90" />
      All runs
    </Link>
  );

  if (error) {
    return (
      <div>
        {backLink}
        <div className="rounded-md border border-fh-border bg-fh-surface">
          <EmptyState icon={<Icons.XIcon size={26} />} title="Run not found" description={error} />
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div>
        {backLink}
        <Skeleton className="h-28 w-full rounded-md" />
      </div>
    );
  }

  return (
    <div>
      {backLink}
      <div className="mb-4 rounded-md border border-fh-border bg-fh-surface">
        <div className="flex items-start gap-3 p-4">
          <CheckStatusIcon state={runState(run)} size={20} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <h2 className="text-fh-lg font-semibold leading-snug text-fh-fg break-words">{run.workflowName}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-fh-xs text-fh-fg-muted">
              <span className="rounded bg-fh-neutral-muted px-1.5 py-0.5 font-medium">{run.trigger}</span>
              {run.ref && <span className="font-mono">{run.ref}</span>}
              <Link to={`${base}/commits/${run.commitSha}`} className="font-mono text-fh-accent-fg no-underline hover:underline">
                {run.shortSha}
              </Link>
              <span aria-hidden="true">·</span>
              <RelativeTime date={run.createdAt} />
              <span className="font-mono text-fh-fg-subtle">{run.workflowPath}</span>
            </p>
          </div>
          <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-fh-xs font-medium", stateBadgeClasses(runState(run)))}>
            {runStateLabel(run)}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {run.checkRuns.map((check) => (
          <JobLog key={check.id} token={token} handle={handle} repoName={repoName} runId={run.id} check={check} />
        ))}
      </div>
    </div>
  );
}

// ─── Entry ──────────────────────────────────────────────────────────────────────

export function RepoActionsTab({ token, handle, repoName, splat }: Props) {
  const base = `/${handle}/${repoName}`;
  const match = splat.match(/^actions\/runs\/([^/]+)$/);
  if (match) {
    return <RunDetail token={token} handle={handle} repoName={repoName} splat={splat} id={match[1]} base={base} />;
  }
  return <RunsList token={token} handle={handle} repoName={repoName} splat={splat} base={base} />;
}
