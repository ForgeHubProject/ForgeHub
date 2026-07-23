import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, cx, EmptyState, LabelChip, RelativeTime, Skeleton } from "../../../ui";
import { getMilestone, listIssues } from "../../../api";
import type { Issue, Milestone } from "../../../types";
import { MilestoneProgress } from "./Sidebar";
import { StateIcon } from "./parts";
import { ChevronLeftIcon, CommentIcon, MilestoneIcon } from "./icons";

function dueLabel(m: Milestone): { text: string; overdue: boolean } {
  if (!m.dueOn) return { text: "No due date", overdue: false };
  const d = new Date(m.dueOn);
  if (Number.isNaN(d.getTime())) return { text: "No due date", overdue: false };
  const nice = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const overdue = m.state === "open" && d.getTime() < Date.now();
  return { text: overdue ? `Past due by ${nice}` : `Due by ${nice}`, overdue };
}

export function MilestoneDetailView({ token, handle, repoName, number }: {
  token: string; handle: string; repoName: string; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [milestone, setMilestone] = useState<Milestone | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"open" | "closed">("open");

  useEffect(() => {
    setLoading(true);
    setError(null);
    getMilestone(token, handle, repoName, number)
      .then((m) => {
        setMilestone(m);
        // Fetch the issues in this milestone (by title, the server's filter key).
        return listIssues(token, handle, repoName, "all", undefined, undefined, undefined, undefined, m.title)
          .then((res) => setIssues(res.issues))
          .catch(() => setIssues([]));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Milestone not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  const openCount = issues.filter((i) => i.state === "open").length;
  const closedCount = issues.filter((i) => i.state === "closed").length;

  const visible = useMemo(
    () => issues.filter((i) => i.state === state).sort((a, b) => (a.number < b.number ? 1 : -1)),
    [issues, state],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error || !milestone) {
    return (
      <EmptyState
        bordered
        title="Milestone not found"
        description={error ?? "This milestone may have been deleted."}
        actions={<Button variant="default" onClick={() => navigate(`${base}/issues/milestones`)}>Back to milestones</Button>}
      />
    );
  }

  const due = dueLabel(milestone);

  const toggle = (
    <div className="flex items-center gap-4">
      {([
        ["open", openCount, "Open"],
        ["closed", closedCount, "Closed"],
      ] as const).map(([s, count, text]) => (
        <button
          key={s}
          type="button"
          onClick={() => setState(s)}
          className={cx(
            "inline-flex items-center gap-1.5 text-fh-sm transition-colors",
            state === s ? "font-semibold text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg",
          )}
          aria-pressed={state === s}
        >
          <StateIcon state={s} size={16} />
          <span>{count}</span>
          <span>{text}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <Link
        to={`${base}/issues/milestones`}
        className="inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-3"
      >
        <ChevronLeftIcon size={14} />
        Milestones
      </Link>

      {/* Header */}
      <div className="pb-5 mb-5 border-b border-fh-border">
        <div className="flex items-center gap-2">
          <span className="text-fh-fg-subtle"><MilestoneIcon size={18} /></span>
          <h1 className="text-fh-2xl font-semibold text-fh-fg">{milestone.title}</h1>
          {milestone.state === "closed" && (
            <span className="inline-flex items-center h-6 px-2 rounded-full text-fh-xs font-medium text-white bg-fh-purple-emphasis">
              Closed
            </span>
          )}
        </div>
        <p className={cx("mt-1 text-fh-sm", due.overdue ? "text-fh-danger-fg font-medium" : "text-fh-fg-muted")}>
          {due.text}
          {milestone.dueOn && <span className="text-fh-fg-subtle"> · <RelativeTime date={milestone.dueOn} /></span>}
        </p>
        {milestone.description && (
          <p className="mt-3 text-fh-base text-fh-fg-muted max-w-3xl whitespace-pre-wrap">{milestone.description}</p>
        )}

        <div className="mt-4 max-w-xl">
          <MilestoneProgress percent={milestone.percent} />
          <div className="mt-1.5 flex items-center gap-4 text-fh-sm text-fh-fg-muted">
            <span className="font-semibold text-fh-fg">{milestone.percent}% complete</span>
            <span>{milestone.openItems} open</span>
            <span>{milestone.closedItems} closed</span>
          </div>
        </div>
      </div>

      {/* Filtered issue list */}
      <div className="border border-fh-border rounded-md">
        <div className="flex items-center px-4 py-2.5 bg-fh-surface-muted border-b border-fh-border rounded-t-md">
          {toggle}
        </div>
        {visible.length === 0 ? (
          <div className="bg-fh-surface rounded-b-md">
            <EmptyState
              title={state === "open" ? "No open issues in this milestone" : "No closed issues in this milestone"}
              description={
                state === "open"
                  ? "Assign issues to this milestone from an issue's sidebar or with the /milestone comment command."
                  : "Nothing has been closed in this milestone yet."
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-fh-border bg-fh-surface rounded-b-md overflow-hidden">
            {visible.map((issue) => (
              <li key={issue.id}>
                <Link
                  to={`${base}/issues/${issue.number}`}
                  className="group flex items-start gap-3 px-4 py-3 hover:bg-fh-surface-muted transition-colors"
                >
                  <span className="mt-0.5 shrink-0"><StateIcon state={issue.state} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-x-2 gap-y-1 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg group-hover:text-fh-accent-fg">{issue.title}</span>
                      {issue.labels.map((l) => (
                        <LabelChip key={l.id} name={l.name} color={l.color} />
                      ))}
                    </div>
                    <div className="mt-1 text-fh-sm text-fh-fg-muted">
                      #{issue.number}{" "}
                      {issue.state === "open" ? "opened " : "closed "}
                      <RelativeTime date={issue.state === "open" ? issue.createdAt : (issue.closedAt ?? issue.updatedAt)} />
                      {" by "}{issue.author}
                    </div>
                  </div>
                  {issue.commentCount > 0 && (
                    <span className="inline-flex items-center gap-1 shrink-0 pl-2 text-fh-sm text-fh-fg-muted group-hover:text-fh-fg">
                      <CommentIcon size={14} />
                      {issue.commentCount}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
