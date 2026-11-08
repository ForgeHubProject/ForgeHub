import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getCollaboratingRepos, getMyOrgs, getMyRepos, listMyIssues, listMyPulls, type MyWorkItem } from "../api";
import { CreateRepoDialog } from "../components/CreateRepoDialog";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { Organization, Repo, User } from "../types";
import { Avatar, Button, EmptyState, Icons, Skeleton, TabItem, TabNav, TextInput } from "../ui";
import { FeedList } from "./FeedPage";
import { PlusIcon, RepoIcon } from "./listShared";
import { WorkRow } from "./YourWorkPage";

type Props = {
  token: string;
  user: User;
  onSelectRepo: (repo: Repo) => void;
  onLogout: () => void;
};

function repoHref(repo: Repo): string {
  return `/${repo.ownerHandle ?? ""}/${repo.name}`;
}

export function RepoListPage({ token, user, onLogout }: Props) {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [collabRepos, setCollabRepos] = useState<Repo[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  // "+ New repository" in the header lands here with ?new=repo.
  const [showCreate, setShowCreate] = useState(params.get("new") === "repo");
  const [showAll, setShowAll] = useState(false);
  const tab = params.get("tab") === "feed" ? "feed" : "home";

  useEffect(() => {
    Promise.all([getMyRepos(token), getCollaboratingRepos(token)])
      .then(([mine, collab]) => {
        setRepos(mine.repos);
        setCollabRepos(collab.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
    // Orgs the caller belongs to — used by the create dialog's namespace picker.
    getMyOrgs(token)
      .then(({ orgs: o }) => setOrgs(o))
      .catch(() => setOrgs([]));
  }, [token]);

  const { filteredOwn, filteredCollab } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return { filteredOwn: repos, filteredCollab: collabRepos };
    return {
      filteredOwn: repos.filter((r) => r.name.toLowerCase().includes(q)),
      filteredCollab: collabRepos.filter(
        (r) => r.name.toLowerCase().includes(q) || r.ownerHandle?.toLowerCase().includes(q),
      ),
    };
  }, [filter, repos, collabRepos]);

  const totalCount = repos.length + collabRepos.length;
  const hasResults = filteredOwn.length > 0 || filteredCollab.length > 0;

  function onCreated(repo: Repo) {
    setShowCreate(false);
    // A personal repo joins the list in place; an org repo lives on the org profile.
    if (repo.orgId) {
      navigate(repoHref(repo));
    } else {
      setRepos((prev) => [repo, ...prev]);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6">
        <div className="flex flex-col gap-6 md:flex-row">
          {/* Left rail — identity + repository controls */}
          <aside className="w-full flex-shrink-0 md:w-[296px]">
            <div className="md:sticky md:top-20">
              <Link to={`/${user.handle}`} className="group flex items-center gap-3 no-underline">
                <Avatar name={user.displayName ?? user.handle} size={44} />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-fh-fg group-hover:text-fh-accent-fg">
                    {user.displayName ?? user.handle}
                  </p>
                  <p className="truncate text-fh-sm text-fh-fg-muted">@{user.handle}</p>
                </div>
              </Link>

              <div className="mt-6 border-t border-fh-border pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-fh-base font-semibold text-fh-fg">Your repositories</h2>
                  <Button
                    variant="primary"
                    size="sm"
                    leadingIcon={<PlusIcon size={14} />}
                    onClick={() => setShowCreate(true)}
                  >
                    New
                  </Button>
                </div>

                <div className="relative mt-3">
                  <Icons.SearchIcon
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fh-fg-muted"
                  />
                  <TextInput
                    sizing="sm"
                    className="pl-8"
                    placeholder="Find a repository…"
                    aria-label="Find a repository"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    disabled={loading || (!!error && totalCount === 0)}
                  />
                </div>

                {loading ? (
                  <div className="mt-3 space-y-2" aria-hidden="true">
                    {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="text" width={`${70 - i * 8}%`} />)}
                  </div>
                ) : error ? (
                  <p className="mt-3 text-fh-sm text-fh-danger-fg">{error}</p>
                ) : (
                  <>
                    <ul className="mt-3 space-y-0.5">
                      {[...filteredOwn, ...filteredCollab].slice(0, showAll ? undefined : 10).map((repo) => (
                        <li key={repo.id}>
                          <Link
                            to={repoHref(repo)}
                            className="flex items-center gap-2 rounded-md px-1 py-1 text-fh-sm text-fh-fg no-underline hover:bg-fh-surface-muted"
                          >
                            <Avatar name={repo.ownerHandle ?? user.handle} size={16} square={!!repo.orgId} />
                            <span className="truncate font-semibold">{repo.ownerHandle ?? user.handle}/{repo.name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {!showAll && filteredOwn.length + filteredCollab.length > 10 && (
                      <button type="button" onClick={() => setShowAll(true)} className="mt-1 px-1 text-fh-xs text-fh-fg-muted hover:text-fh-accent-fg">
                        Show more
                      </button>
                    )}
                    {totalCount > 0 && !hasResults && (
                      <p className="mt-2 px-1 text-fh-xs text-fh-fg-subtle">No repository matches “{filter.trim()}”.</p>
                    )}
                  </>
                )}

                {/* Organizations the caller belongs to */}
                {orgs.length > 0 && (
                  <div className="mt-6 border-t border-fh-border pt-4">
                    <h2 className="mb-2 text-fh-xs font-semibold uppercase tracking-wide text-fh-fg-subtle">
                      Organizations
                    </h2>
                    <div className="flex flex-col gap-1">
                      {orgs.map((o) => (
                        <Link
                          key={o.id}
                          to={`/${o.handle}`}
                          className="group flex items-center gap-2 rounded-md px-1 py-1 no-underline hover:bg-fh-surface-muted"
                        >
                          <Avatar name={o.displayName || o.handle} square size={20} />
                          <span className="truncate text-fh-sm text-fh-fg group-hover:text-fh-accent-fg">
                            {o.handle}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>

          {/* Main — GitHub's dashboard: Home (your work) and Feed */}
          <main className="min-w-0 flex-1">
            <TabNav aria-label="Dashboard" className="mb-5">
              <TabItem active={tab === "home"} onClick={() => setParams({})}>Home</TabItem>
              <TabItem active={tab === "feed"} onClick={() => setParams({ tab: "feed" })}>Feed</TabItem>
            </TabNav>

            {tab === "feed" ? (
              <FeedList token={token} />
            ) : !loading && !error && totalCount === 0 ? (
              <EmptyState
                bordered
                icon={<RepoIcon size={28} />}
                title="No repositories yet"
                description="Your code lives in repositories. Create your first one to start pushing commits, opening issues, and cutting releases."
                actions={
                  <Button variant="primary" leadingIcon={<PlusIcon size={14} />} onClick={() => setShowCreate(true)}>
                    New repository
                  </Button>
                }
              />
            ) : (
              <div className="space-y-6">
                <WorkSection
                  title="Review requests"
                  kind="pulls"
                  load={() => listMyPulls(token, "review_requested").then((d) => d.pulls)}
                  all="/pulls?filter=review_requested"
                  empty="No pull requests are waiting for your review."
                />
                <WorkSection
                  title="Your pull requests"
                  kind="pulls"
                  load={() => listMyPulls(token, "created").then((d) => d.pulls)}
                  all="/pulls?filter=created"
                  empty="You have no open pull requests."
                />
                <WorkSection
                  title="Issues assigned to you"
                  kind="issues"
                  load={() => listMyIssues(token, "assigned").then((d) => d.issues)}
                  all="/issues?filter=assigned"
                  empty="No open issues are assigned to you."
                />
              </div>
            )}
          </main>
        </div>
      </div>

      <Footer />

      <CreateRepoDialog
        open={showCreate}
        token={token}
        personalHandle={user.handle}
        orgs={orgs}
        template={params.get("template") ?? undefined}
        onClose={() => {
          setShowCreate(false);
          if (params.get("new")) setParams({});
        }}
        onCreated={onCreated}
      />
    </div>
  );
}

/** One block of the Home tab: up to five of your open items and a link to all of them. */
function WorkSection({ title, kind, load, all, empty }: {
  title: string;
  kind: "issues" | "pulls";
  load: () => Promise<MyWorkItem[]>;
  all: string;
  empty: string;
}) {
  const [items, setItems] = useState<MyWorkItem[] | null>(null);
  // `load` is a fresh closure each render; run it once per mount.
  useEffect(() => {
    load().then(setItems).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-fh-base font-semibold text-fh-fg">{title}</h2>
        {items && items.length > 0 && <Link to={all} className="text-fh-sm text-fh-accent-fg hover:underline">View all</Link>}
      </div>
      <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
        {items === null ? (
          <div className="px-4 py-3 space-y-2" aria-hidden="true">
            <Skeleton variant="text" width="55%" />
            <Skeleton variant="text" width="35%" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-4 text-fh-sm text-fh-fg-muted">{empty}</p>
        ) : (
          <ul className="divide-y divide-fh-border">
            {items.slice(0, 5).map((it) => (
              <WorkRow key={`${it.repo.owner}/${it.repo.name}#${it.number}`} item={it} kind={kind} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
