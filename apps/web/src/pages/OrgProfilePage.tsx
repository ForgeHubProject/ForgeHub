import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getMyOrgs, getOrg } from "../api";
import { CreateRepoDialog } from "../components/CreateRepoDialog";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { Organization, OrgProfile, Repo, User } from "../types";
import { Avatar, Button, EmptyState, Icons, Skeleton, TextInput } from "../ui";
import { CalendarIcon, PersonIcon, RepoIcon, RepoRow, RowList } from "./listShared";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

function joinedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Organization profile (issue #114). Mirrors the user profile but for an org
 * namespace: identity sidebar, the repos the caller can see, and — for members —
 * the member roster. Owners get a Settings entry; members get New repository.
 */
export function OrgProfilePage({ token, user, onLogout }: Props) {
  const { handle } = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<OrgProfile | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [myOrg, setMyOrg] = useState<Organization | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    setFilter("");
    getOrg(token, handle)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Organization not found"))
      .finally(() => setLoading(false));
    // Learn whether the caller may create repos here (any membership qualifies).
    getMyOrgs(token)
      .then(({ orgs }) => setMyOrg(orgs.find((o) => o.handle === handle) ?? null))
      .catch(() => setMyOrg(null));
  }, [token, handle]);

  const org = data?.org;
  const repos = data?.repos ?? [];
  const isOwner = org?.viewerRole === "OWNER";
  const isMember = org?.viewerRole !== null && org?.viewerRole !== undefined;

  function onCreated(repo: Repo) {
    setShowCreate(false);
    navigate(`/${repo.ownerHandle ?? handle}/${repo.name}`);
  }

  const filteredRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }, [filter, repos]);

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8">
        {loading && (
          <div className="flex flex-col gap-8 sm:flex-row">
            <aside className="w-full flex-shrink-0 sm:w-[296px]">
              <Skeleton variant="block" width={88} height={88} />
              <Skeleton variant="text" width="60%" className="mt-4 h-6" />
              <Skeleton variant="text" width="40%" className="mt-2" />
            </aside>
            <main className="min-w-0 flex-1 space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} width="100%" height={72} />
              ))}
            </main>
          </div>
        )}

        {!loading && (error || !org) && (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-16 text-center">
            <p className="text-fh-lg font-semibold text-fh-fg">Organization not found</p>
            <p className="mt-1 text-fh-base text-fh-fg-muted">{error ?? "This organization does not exist."}</p>
            <Link to="/" className="mt-4 inline-block no-underline">
              <Button variant="default">Back to dashboard</Button>
            </Link>
          </div>
        )}

        {!loading && !error && org && (
          <div className="flex flex-col gap-8 sm:flex-row">
            {/* Left sidebar — org identity */}
            <aside className="w-full flex-shrink-0 sm:w-[296px]">
              <Avatar name={org.displayName || org.handle} square size={88} />
              <div className="mt-4">
                <h1 className="text-fh-2xl font-semibold leading-tight text-fh-fg">{org.displayName || org.handle}</h1>
                <p className="text-fh-lg text-fh-fg-muted">@{org.handle}</p>
              </div>

              <div className="mt-4 flex gap-2">
                {isMember && (
                  <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                    New repository
                  </Button>
                )}
                {isOwner && (
                  <Button variant="default" size="sm" onClick={() => navigate(`/orgs/${org.handle}/settings`)}>
                    Settings
                  </Button>
                )}
              </div>

              <div className="mt-4 space-y-2 text-fh-base">
                {org.description && <p className="text-fh-fg">{org.description}</p>}
                <div className="flex items-center gap-2 text-fh-fg-muted">
                  <PersonIcon size={14} className="shrink-0" />
                  <span>
                    {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-fh-fg-muted">
                  <CalendarIcon size={14} className="shrink-0" />
                  <span>Created {joinedLabel(org.createdAt)}</span>
                </div>
              </div>

              {/* Member roster (members only) */}
              {isMember && data && data.members.length > 0 && (
                <div className="mt-6 border-t border-fh-border pt-4">
                  <h2 className="mb-2 text-fh-xs font-semibold uppercase tracking-wide text-fh-fg-subtle">
                    Members
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {data.members.map((m) => (
                      <Link key={m.id} to={`/${m.handle}`} title={`@${m.handle}${m.role === "OWNER" ? " (owner)" : ""}`}>
                        <Avatar name={m.displayName || m.handle} size={32} />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </aside>

            {/* Main — repositories */}
            <main className="min-w-0 flex-1">
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-fh-border pb-4">
                <h2 className="flex items-center gap-2 text-fh-lg font-semibold text-fh-fg">
                  <RepoIcon className="text-fh-fg-muted" />
                  Repositories
                  <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-fh-neutral-muted px-1.5 text-fh-xs font-semibold text-fh-fg-muted">
                    {repos.length}
                  </span>
                </h2>
                {repos.length > 0 && (
                  <div className="relative ml-auto w-full sm:w-56">
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
                    />
                  </div>
                )}
              </div>

              {repos.length === 0 ? (
                <EmptyState
                  bordered
                  icon={<RepoIcon size={28} />}
                  title="No repositories to show"
                  description={
                    isMember
                      ? "Create a repository in this organization to get started."
                      : `@${org.handle} has no repositories you can see.`
                  }
                  actions={
                    isMember ? (
                      <Button variant="primary" onClick={() => setShowCreate(true)}>
                        New repository
                      </Button>
                    ) : undefined
                  }
                />
              ) : filteredRepos.length === 0 ? (
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
              ) : (
                <RowList aria-label={`Repositories owned by ${org.handle}`}>
                  {filteredRepos.map((repo) => (
                    <RepoRow
                      key={repo.id}
                      to={`/${repo.ownerHandle ?? org.handle}/${repo.name}`}
                      name={repo.name}
                      description={repo.description}
                      visibility={repo.visibility}
                      updatedAt={repo.updatedAt}
                      topics={repo.topics}
                    />
                  ))}
                </RowList>
              )}
            </main>
          </div>
        )}
      </div>

      <Footer />

      {org && (
        <CreateRepoDialog
          open={showCreate}
          token={token}
          personalHandle={user.handle}
          orgs={myOrg ? [myOrg] : []}
          lockedNamespace={org.handle}
          onClose={() => setShowCreate(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}
