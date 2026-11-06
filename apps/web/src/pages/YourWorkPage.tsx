import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listMyIssues, listMyPulls, type MyWorkItem } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import type { User } from "../types";
import { EmptyState, LabelChip, RelativeTime, Skeleton, TabItem, TabNav, cx } from "../ui";
import { IssueClosedIcon, IssueOpenedIcon } from "./repo/issues/icons";
import { PRStateIcon } from "./repo/pulls/prShared";
import { useDocumentTitle } from "./useDocumentTitle";

type Kind = "issues" | "pulls";

const FILTERS: Record<Kind, Array<{ value: string; label: string }>> = {
  issues: [
    { value: "assigned", label: "Assigned" },
    { value: "created", label: "Created" },
    { value: "mentioned", label: "Mentioned" },
  ],
  pulls: [
    { value: "created", label: "Created" },
    { value: "assigned", label: "Assigned" },
    { value: "review_requested", label: "Review requests" },
    { value: "involved", label: "Involves you" },
  ],
};

/**
 * Your issues (/issues) and your pull requests (/pulls) across every
 * repository (#255), GitHub's: filters along the top, open / closed, and one
 * row per item with its repository.
 */
export function YourWorkPage({ kind, token, user, onLogout }: { kind: Kind; token: string; user: User; onLogout: () => void }) {
  useDocumentTitle(`${kind === "issues" ? "Issues" : "Pull requests"} · ForgeHub`);
  const [params, setParams] = useSearchParams();
  const filter = FILTERS[kind].some((f) => f.value === params.get("filter")) ? params.get("filter")! : FILTERS[kind][0].value;
  const state = params.get("state") === "closed" ? "closed" : "open";
  const [items, setItems] = useState<MyWorkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    const load = kind === "issues"
      ? listMyIssues(token, filter, state).then((d) => d.issues)
      : listMyPulls(token, filter, state === "closed" ? "all" : "open").then((d) => (state === "closed" ? d.pulls.filter((p) => p.state !== "open") : d.pulls));
    load.then(setItems).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load"));
  }, [kind, token, filter, state]);

  const set = (next: Record<string, string>) => setParams({ filter, state, ...next });
  const noun = kind === "issues" ? "issues" : "pull requests";

  return (
    <div className="min-h-screen flex flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="flex-1 w-full max-w-[1100px] mx-auto px-4 py-8">
        <TabNav aria-label={kind === "issues" ? "Issue filters" : "Pull request filters"} className="mb-4">
          {FILTERS[kind].map((f) => (
            <TabItem key={f.value} active={filter === f.value} onClick={() => set({ filter: f.value })}>
              {f.label}
            </TabItem>
          ))}
        </TabNav>

        <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
          <div className="flex items-center gap-4 px-4 py-2.5 bg-fh-canvas border-b border-fh-border text-fh-sm">
            {(["open", "closed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => set({ state: s })}
                className={cx("inline-flex items-center gap-1.5", state === s ? "font-semibold text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg")}
              >
                {s === "open" ? <IssueOpenedIcon size={15} /> : <IssueClosedIcon size={15} />}
                {s === "open" ? "Open" : "Closed"}
              </button>
            ))}
          </div>

          {items === null && !error ? (
            <div className="divide-y divide-fh-border">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-4 py-3 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              ))}
            </div>
          ) : error ? (
            <EmptyState title="Couldn't load your work" description={error} />
          ) : items!.length === 0 ? (
            <EmptyState
              title={`No ${state} ${noun}`}
              description={`${noun[0].toUpperCase()}${noun.slice(1)} from every repository you can see show up here.`}
            />
          ) : (
            <ul className="divide-y divide-fh-border">
              {items!.map((it) => (
                <WorkRow key={`${it.repo.owner}/${it.repo.name}#${it.number}`} item={it} kind={kind} />
              ))}
            </ul>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}

/** One issue or pull request, with its repository in front, as GitHub lists them. */
export function WorkRow({ item, kind }: { item: MyWorkItem; kind: Kind }) {
  const repoPath = `/${item.repo.owner}/${item.repo.name}`;
  const href = `${repoPath}/${kind}/${item.number}`;
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 hover:bg-fh-surface-muted/60">
      <span className="mt-0.5 shrink-0">
        {kind === "pulls" ? (
          <PRStateIcon state={item.state as "open" | "closed" | "merged"} draft={item.isDraft} />
        ) : item.state === "open" ? (
          <IssueOpenedIcon size={16} className="text-fh-success-fg" />
        ) : (
          <IssueClosedIcon size={16} className="text-fh-purple-fg" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-fh-base leading-snug break-words">
          <Link to={repoPath} className="text-fh-fg-muted hover:text-fh-accent-fg">{item.repo.owner}/{item.repo.name}</Link>{" "}
          <Link to={href} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{item.title}</Link>
          {item.labels.map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} className="ml-1.5 align-middle" />
          ))}
        </p>
        <p className="mt-0.5 text-fh-xs text-fh-fg-muted">
          #{item.number} {item.state === "open" ? "opened" : item.state} <RelativeTime date={item.createdAt} /> by {item.author}
          {item.assignee && <> · assigned to {item.assignee}</>}
        </p>
      </div>
      {item.comments > 0 && (
        <Link to={href} className="shrink-0 text-fh-xs text-fh-fg-muted hover:text-fh-accent-fg">💬 {item.comments}</Link>
      )}
    </li>
  );
}
