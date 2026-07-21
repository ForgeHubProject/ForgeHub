import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listPulls } from "../../../api";
import type { PullRequest } from "../../../types";
import { Button, EmptyState, RelativeTime, Skeleton, cx } from "../../../ui";
import { BranchFlow, GitPullRequestIcon, PRStateIcon, type PRState } from "./prShared";

type FilterKey = "open" | "merged" | "closed";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
];

export function PullsList({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const [filter, setFilter] = useState<FilterKey>("open");
  const [all, setAll] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setAll(null);
    setError(null);
    listPulls(token, handle, repoName, "all")
      .then((d) => alive && setAll(d.pulls))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load pull requests"));
    return () => {
      alive = false;
    };
  }, [token, handle, repoName]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { open: 0, merged: 0, closed: 0 };
    for (const pr of all ?? []) c[pr.state] += 1;
    return c;
  }, [all]);

  const rows = useMemo(() => (all ?? []).filter((pr) => pr.state === filter), [all, filter]);
  const loading = all === null && !error;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-fh-lg font-semibold text-fh-fg">Pull requests</h2>
        <Link to={`${base}/pulls/new`} className="ml-auto no-underline">
          <Button variant="primary" leadingIcon={<GitPullRequestIcon size={15} />}>
            New pull request
          </Button>
        </Link>
      </div>

      {/* Filter segmented control */}
      <div className="inline-flex items-center gap-1 p-1 mb-4 rounded-md border border-fh-border bg-fh-surface">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={cx(
                "inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-fh-sm transition-colors",
                active
                  ? "bg-fh-surface-muted text-fh-fg font-semibold"
                  : "text-fh-fg-muted hover:text-fh-fg hover:bg-fh-surface-muted/60",
              )}
            >
              <PRStateIcon state={f.key as PRState} size={15} />
              {f.label}
              <span
                className={cx(
                  "inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-fh-xs font-semibold",
                  "bg-fh-neutral-muted",
                  active ? "text-fh-fg" : "text-fh-fg-muted",
                )}
              >
                {all === null ? "–" : counts[f.key]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
        {loading ? (
          <div className="divide-y divide-fh-border">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="w-4 h-4 mt-0.5 rounded" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-6 py-12 text-center text-fh-sm text-fh-danger-fg">{error}</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<GitPullRequestIcon size={28} />}
            title={
              filter === "open"
                ? "No open pull requests"
                : filter === "merged"
                  ? "No merged pull requests"
                  : "No closed pull requests"
            }
            description="Push a branch and open a pull request to propose changes."
            actions={
              filter === "open" ? (
                <Link to={`${base}/pulls/new`} className="no-underline">
                  <Button variant="primary" leadingIcon={<GitPullRequestIcon size={15} />}>
                    New pull request
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-fh-border">
            {rows.map((pr) => (
              <li key={pr.id}>
                <button
                  type="button"
                  onClick={() => navigate(`${base}/pulls/${pr.number}`)}
                  className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-fh-surface-muted/60 transition-colors"
                >
                  <span className="mt-0.5">
                    <PRStateIcon state={pr.state} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg hover:text-fh-accent-fg truncate">
                        {pr.title}
                      </span>
                    </div>
                    <p className="mt-1 text-fh-sm text-fh-fg-muted">
                      <span className="text-fh-fg-subtle">#{pr.number}</span>{" "}
                      {pr.state === "open" ? "opened" : pr.state} <RelativeTime date={pr.createdAt} /> by{" "}
                      <span className="text-fh-fg-muted">{pr.author}</span>
                    </p>
                    <div className="mt-2">
                      <BranchFlow from={pr.fromBranch} to={pr.toBranch} />
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
