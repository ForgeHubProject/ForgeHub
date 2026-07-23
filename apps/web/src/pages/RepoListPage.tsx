import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getCollaboratingRepos, getMyOrgs, getMyRepos } from "../api";
import { CreateRepoDialog } from "../components/CreateRepoDialog";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { Organization, Repo, User } from "../types";
import { Avatar, Button, EmptyState, Icons, Skeleton, TextInput } from "../ui";
import { PlusIcon, RepoIcon, RepoRow, RowList } from "./listShared";

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
  const [showCreate, setShowCreate] = useState(false);

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

                {!loading && !error && totalCount > 0 && (
                  <p className="mt-3 text-fh-xs text-fh-fg-subtle">
                    {totalCount} {totalCount === 1 ? "repository" : "repositories"}
                  </p>
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

          {/* Main — repository rows */}
          <main className="min-w-0 flex-1">
            {loading && (
              <RowList aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <Skeleton variant="circle" width={16} height={16} className="mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <Skeleton variant="text" width="40%" />
                      <Skeleton variant="text" width="70%" />
                    </div>
                  </div>
                ))}
              </RowList>
            )}

            {!loading && error && (
              <div className="rounded-md border border-fh-border bg-fh-surface px-4 py-4 text-fh-sm text-fh-danger-fg">
                {error}
              </div>
            )}

            {!loading && !error && totalCount === 0 && (
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
            )}

            {!loading && !error && totalCount > 0 && (
              <div className="space-y-6">
                {filteredOwn.length > 0 && (
                  <RowList aria-label="Your repositories">
                    {filteredOwn.map((repo) => (
                      <RepoRow
                        key={repo.id}
                        to={repoHref(repo)}
                        name={repo.name}
                        description={repo.description}
                        visibility={repo.visibility}
                        updatedAt={repo.updatedAt}
                        topics={repo.topics}
                      />
                    ))}
                  </RowList>
                )}

                {filteredCollab.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-fh-xs font-semibold uppercase tracking-wide text-fh-fg-subtle">
                      Collaborating on
                    </h3>
                    <RowList aria-label="Repositories you collaborate on">
                      {filteredCollab.map((repo) => (
                        <RepoRow
                          key={repo.id}
                          to={repoHref(repo)}
                          name={repo.fullName ?? `${repo.ownerHandle}/${repo.name}`}
                          description={repo.description}
                          visibility={repo.visibility}
                          updatedAt={repo.updatedAt}
                          topics={repo.topics}
                        />
                      ))}
                    </RowList>
                  </section>
                )}

                {!hasResults && (
                  <EmptyState
                    bordered
                    icon={<Icons.SearchIcon size={28} />}
                    title="No matching repositories"
                    description={`No repository matches “${filter.trim()}”.`}
                    actions={
                      <Button variant="default" onClick={() => setFilter("")}>
                        Clear filter
                      </Button>
                    }
                  />
                )}
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
        onClose={() => setShowCreate(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
