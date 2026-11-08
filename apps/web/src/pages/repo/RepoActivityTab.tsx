import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { avatarSrc, listRepoActivity } from "../../api";
import type { BranchInfo, RefActivity } from "../../types";
import { Avatar, Button, EmptyState, PageHeading, RelativeTime, Select, Skeleton, TextInput } from "../../ui";

const KINDS: Array<{ value: RefActivity["kind"] | ""; label: string }> = [
  { value: "", label: "All activity" },
  { value: "push", label: "Direct pushes" },
  { value: "force_push", label: "Force pushes" },
  { value: "branch_created", label: "Branch creations" },
  { value: "branch_deleted", label: "Branch deletions" },
  { value: "merge", label: "Pull request merges" },
];

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

/**
 * Activity (#256), GitHub's /activity: what happened to the repository's
 * branches (pushes, force pushes, branches made and deleted, merges), by
 * branch, kind and person.
 */
export function RepoActivityTab({ token, handle, repoName, branches, base }: {
  token: string; handle: string; repoName: string; branches: BranchInfo[]; base: string;
}) {
  const [params, setParams] = useSearchParams();
  const branch = params.get("ref") ?? "";
  const kind = (params.get("activity_type") ?? "") as RefActivity["kind"] | "";
  const actor = params.get("actor") ?? "";
  const [actorDraft, setActorDraft] = useState(actor);
  const [events, setEvents] = useState<RefActivity[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    (before?: string) =>
      listRepoActivity(token, handle, repoName, { branch: branch || undefined, kind: kind || undefined, actor: actor || undefined, before }),
    [token, handle, repoName, branch, kind, actor],
  );

  useEffect(() => {
    setEvents(null);
    load()
      .then((d) => {
        setEvents(d.events);
        setNext(d.next);
      })
      .catch(() => setEvents([]));
  }, [load]);

  function setParam(key: string, value: string) {
    const nextParams = new URLSearchParams(params);
    if (value) nextParams.set(key, value);
    else nextParams.delete(key);
    setParams(nextParams, { replace: true });
  }

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const d = await load(next);
      setEvents((prev) => [...(prev ?? []), ...d.events]);
      setNext(d.next);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <PageHeading title="Activity" description="Pushes, force pushes, branches and merges on this repository." divider />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-48">
        <Select sizing="sm" aria-label="Branch" value={branch} onChange={(e) => setParam("ref", e.target.value)}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>{b.name}</option>
          ))}
        </Select>
        </div>
        <div className="w-48">
        <Select sizing="sm" aria-label="Activity type" value={kind} onChange={(e) => setParam("activity_type", e.target.value)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </Select>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam("actor", actorDraft.trim().replace(/^@/, ""));
          }}
        >
          <TextInput sizing="sm" aria-label="Filter by person" placeholder="Filter by person…" value={actorDraft} onChange={(e) => setActorDraft(e.target.value)} className="w-48" />
        </form>
      </div>

      {events === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={52} />)}</div>
      ) : events.length === 0 ? (
        <EmptyState bordered title="No activity yet" description="Branch updates from now on show up here." />
      ) : (
        <>
          <ul className="divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3 text-fh-sm">
                <Avatar name={e.actor?.displayName || e.actor?.handle || "?"} src={e.actor ? avatarSrc(e.actor.handle, e.actor.avatarKey) : undefined} size={24} />
                <p className="min-w-0 flex-1 text-fh-fg">
                  {e.actor ? <Link to={`/${e.actor.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{e.actor.handle}</Link> : <span className="font-semibold">Someone</span>}{" "}
                  <ActivityText event={e} base={base} />
                </p>
                {e.beforeSha && e.afterSha && e.kind !== "merge" && (
                  <Link to={`${base}/compare/${e.beforeSha}...${e.afterSha}`} className="shrink-0 font-mono text-fh-xs text-fh-accent-fg hover:underline">
                    {short(e.beforeSha)}…{short(e.afterSha)}
                  </Link>
                )}
                <RelativeTime date={e.createdAt} className="w-24 shrink-0 text-right text-fh-xs text-fh-fg-muted" />
              </li>
            ))}
          </ul>
          {next && (
            <div className="mt-4 text-center">
              <Button variant="default" loading={loadingMore} onClick={() => void more()}>Load more</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActivityText({ event: e, base }: { event: RefActivity; base: string }) {
  const branch = <code className="rounded bg-fh-accent-muted px-1 font-mono text-fh-xs text-fh-accent-fg">{e.ref}</code>;
  switch (e.kind) {
    case "push":
      return <>pushed {e.commits != null ? `${e.commits} ${e.commits === 1 ? "commit" : "commits"} ` : ""}to {branch}</>;
    case "force_push":
      return <>force-pushed {branch}</>;
    case "branch_created":
      return <>created {branch}</>;
    case "branch_deleted":
      return <>deleted {branch}</>;
    case "merge":
      return <>merged <Link to={`${base}/pulls/${e.prNumber}`} className="text-fh-accent-fg hover:underline">#{e.prNumber}</Link> into {branch}</>;
  }
}
