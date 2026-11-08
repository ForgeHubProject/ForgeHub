import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { avatarSrc, getPins, listPeople, listStarredRepos, setPins } from "../api";
import type { ActivityMonth, ActivityRow, PersonCard, Repo } from "../types";
import { Avatar, Badge, Button, Dialog, EmptyState, Skeleton, TextInput, useToast } from "../ui";
import { RepoIcon, RepoRow, RowList } from "./listShared";

const repoPath = (r: Repo, fallbackOwner: string) => `/${r.ownerHandle ?? fallbackOwner}/${r.name}`;

/**
 * GitHub's "Pinned" grid on a profile's Overview (#257): up to six cards, and
 * "Customize your pins" on your own profile.
 */
export function PinnedRepos({ token, handle, own, candidates }: { token: string; handle: string; own: boolean; candidates: Repo[] }) {
  const [pins, setPinsState] = useState<Repo[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getPins(token, handle).then((d) => setPinsState(d.repos)).catch(() => setPinsState([]));
  }, [token, handle]);

  if (pins === null) return null;
  // Nothing pinned: GitHub shows the most-starred repositories instead.
  const popular = pins.length === 0;
  const shown = popular
    ? [...candidates].sort((a, b) => (b.starCount ?? 0) - (a.starCount ?? 0) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
    : pins;
  if (shown.length === 0 && !own) return null;
  return (
    <section className="mb-6" aria-label={popular ? "Popular repositories" : "Pinned"}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-fh-base font-semibold text-fh-fg">{popular ? "Popular repositories" : "Pinned"}</h2>
        {own && (
          <button type="button" onClick={() => setEditing(true)} className="text-fh-sm text-fh-accent-fg hover:underline">
            Customize your pins
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-fh-border px-4 py-6 text-center text-fh-sm text-fh-fg-muted">
          Pin up to six repositories to show them here.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((r) => (
            <div key={r.id} className="flex flex-col rounded-md border border-fh-border bg-fh-surface p-4">
              <div className="flex items-center gap-2 min-w-0">
                <RepoIcon size={16} className="shrink-0 text-fh-fg-muted" />
                <Link to={repoPath(r, handle)} className="truncate font-semibold text-fh-accent-fg hover:underline">
                  {r.ownerHandle && r.ownerHandle !== handle ? `${r.ownerHandle}/${r.name}` : r.name}
                </Link>
                <Badge variant="outline" tone={r.visibility === "public" ? "neutral" : "warning"}>
                  {r.visibility === "public" ? "Public" : "Private"}
                </Badge>
              </div>
              <p className="mt-2 flex-1 text-fh-sm text-fh-fg-muted line-clamp-2">{r.description || " "}</p>
              <p className="mt-3 text-fh-xs text-fh-fg-subtle">★ {r.starCount ?? 0}</p>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <CustomizePins
          token={token}
          current={pins}
          candidates={candidates}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setPinsState(next);
            setEditing(false);
          }}
        />
      )}
    </section>
  );
}

function CustomizePins({ token, current, candidates, onClose, onSaved }: {
  token: string;
  current: Repo[];
  candidates: Repo[];
  onClose: () => void;
  onSaved: (pins: Repo[]) => void;
}) {
  const { toast } = useToast();
  const [chosen, setChosen] = useState<string[]>(current.map((r) => r.id));
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const all = [...current, ...candidates.filter((c) => !current.some((p) => p.id === c.id))];
  const shown = all.filter((r) => !filter.trim() || r.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(id: string) {
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < 6 ? [...c, id] : c));
  }

  async function save() {
    setSaving(true);
    try {
      await setPins(token, chosen);
      onSaved(chosen.map((id) => all.find((r) => r.id === id)!).filter(Boolean));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save your pins", { tone: "danger" });
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit pinned items"
      description={`Select up to six repositories. ${6 - chosen.length} remaining.`}
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Save pins</Button>
        </>
      }
    >
      <TextInput aria-label="Filter repositories" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-3" />
      <ul className="max-h-80 overflow-y-auto divide-y divide-fh-border-muted rounded-md border border-fh-border">
        {shown.map((r) => (
          <li key={r.id}>
            <label className="flex items-center gap-2 px-3 py-2 text-fh-sm cursor-pointer hover:bg-fh-surface-muted">
              <input type="checkbox" checked={chosen.includes(r.id)} disabled={!chosen.includes(r.id) && chosen.length >= 6} onChange={() => toggle(r.id)} />
              <RepoIcon size={14} className="text-fh-fg-muted" />
              <span className="truncate">{r.fullName ?? r.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** A profile's Stars tab (#257): the repositories they starred, newest first. */
export function StarsList({ token, handle }: { token: string; handle: string }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  useEffect(() => {
    listStarredRepos(token, handle, 1, 100).then((d) => setRepos(d.repos)).catch(() => setRepos([]));
  }, [token, handle]);
  if (repos === null) return <Skeleton width="100%" height={72} />;
  if (repos.length === 0) {
    return <EmptyState bordered title={`@${handle} hasn't starred any repositories yet`} description="Starring a repository bookmarks it, and its activity shows in your feed." />;
  }
  return (
    <RowList aria-label={`Repositories ${handle} starred`}>
      {repos.map((r) => (
        <RepoRow key={r.id} to={repoPath(r, handle)} name={r.fullName ?? r.name} description={r.description} visibility={r.visibility} updatedAt={r.updatedAt} topics={r.topics} />
      ))}
    </RowList>
  );
}

/** Followers or Following (#257). */
export function PeopleList({ token, handle, kind }: { token: string; handle: string; kind: "followers" | "following" }) {
  const [people, setPeople] = useState<PersonCard[] | null>(null);
  useEffect(() => {
    listPeople(token, handle, kind).then((d) => setPeople(d.users)).catch(() => setPeople([]));
  }, [token, handle, kind]);
  if (people === null) return <Skeleton width="100%" height={72} />;
  if (people.length === 0) {
    return <EmptyState bordered title={kind === "followers" ? `No one follows @${handle} yet` : `@${handle} isn't following anyone yet`} />;
  }
  return (
    <ul className="divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
      {people.map((p) => (
        <li key={p.handle} className="flex items-start gap-3 px-4 py-3">
          <Avatar name={p.displayName || p.handle} src={avatarSrc(p.handle, p.avatarKey)} size={40} />
          <div className="min-w-0">
            <Link to={`/${p.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">
              {p.displayName || p.handle}
            </Link>{" "}
            <span className="text-fh-sm text-fh-fg-muted">{p.handle}</span>
            {p.bio && <p className="mt-0.5 text-fh-sm text-fh-fg-muted">{p.bio}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const repoCount = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * GitHub's "Contribution activity" under the graph (#257): month by month, the
 * repositories created and the pull requests, issues and reviews per repository.
 */
export function ContributionActivity({ months }: { months: ActivityMonth[] }) {
  const [shown, setShown] = useState(2);
  if (months.length === 0) {
    return <p className="rounded-md border border-dashed border-fh-border px-4 py-6 text-center text-fh-sm text-fh-fg-muted">No activity in this period.</p>;
  }
  return (
    <div>
      {months.slice(0, shown).map((m) => {
        const sum = (rows: ActivityRow[]) => rows.reduce((n, r) => n + r.count, 0);
        return (
          <section key={m.month} className="mb-6" aria-label={monthName(m.month)}>
            <h3 className="mb-3 flex items-center gap-3 text-fh-sm font-semibold text-fh-fg">
              {monthName(m.month)}
              <span aria-hidden className="h-px flex-1 bg-fh-border" />
            </h3>
            <ul className="space-y-4 border-l-2 border-fh-border-muted pl-4">
              {m.created.length > 0 && (
                <ActivityGroup title={`Created ${repoCount(m.created.length)}`}>
                  {m.created.map((c) => (
                    <ActivityRepoLine key={c.repo} repo={c.repo} />
                  ))}
                </ActivityGroup>
              )}
              {m.pulls.length > 0 && (
                <ActivityGroup title={`Opened ${plural(sum(m.pulls), "pull request")} in ${repoCount(m.pulls.length)}`}>
                  {m.pulls.map((r) => (
                    <ActivityRepoLine key={r.repo} repo={r.repo} count={r.count} detail={[r.merged && `${r.merged} merged`, r.open && `${r.open} open`]} />
                  ))}
                </ActivityGroup>
              )}
              {m.issues.length > 0 && (
                <ActivityGroup title={`Opened ${plural(sum(m.issues), "issue")} in ${repoCount(m.issues.length)}`}>
                  {m.issues.map((r) => (
                    <ActivityRepoLine key={r.repo} repo={r.repo} count={r.count} detail={[r.open && `${r.open} open`, r.closed && `${r.closed} closed`]} />
                  ))}
                </ActivityGroup>
              )}
              {m.reviews.length > 0 && (
                <ActivityGroup title={`Reviewed ${plural(sum(m.reviews), "pull request")} in ${repoCount(m.reviews.length)}`}>
                  {m.reviews.map((r) => (
                    <ActivityRepoLine key={r.repo} repo={r.repo} count={r.count} />
                  ))}
                </ActivityGroup>
              )}
            </ul>
          </section>
        );
      })}
      {shown < months.length && (
        <Button variant="default" block onClick={() => setShown(shown + 3)}>
          Show more activity
        </Button>
      )}
    </div>
  );
}

function ActivityGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li>
      <p className="text-fh-base text-fh-fg">{title}</p>
      <ul className="mt-1 space-y-1">{children}</ul>
    </li>
  );
}

function ActivityRepoLine({ repo, count, detail = [] }: { repo: string; count?: number; detail?: Array<string | number | false | undefined> }) {
  const notes = detail.filter((d): d is string => typeof d === "string");
  return (
    <li className="flex items-center gap-2 text-fh-sm">
      <RepoIcon size={14} className="shrink-0 text-fh-fg-muted" />
      <Link to={`/${repo}`} className="truncate text-fh-accent-fg hover:underline">{repo}</Link>
      {count != null && <span className="text-fh-fg-muted">{count}</span>}
      {notes.length > 0 && <span className="text-fh-xs text-fh-fg-subtle">{notes.join(" · ")}</span>}
    </li>
  );
}
