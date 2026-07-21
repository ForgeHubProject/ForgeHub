import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { search } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { SearchIssueResult, SearchRepoResult, SearchUserResult, User } from "../types";
import { Avatar, Badge, Button, EmptyState, Icons, RelativeTime, Skeleton, TextInput, cx } from "../ui";
import { IssueClosedIcon, IssueOpenIcon, PersonIcon, RepoIcon, RepoRow, RowList } from "./listShared";

type Props = { token: string; user: User; onLogout: () => void };
type SearchType = "repos" | "issues" | "users";

type SearchData = {
  repos: SearchRepoResult[];
  issues: SearchIssueResult[];
  users: SearchUserResult[];
};

const EMPTY: SearchData = { repos: [], issues: [], users: [] };

const TYPES: { key: SearchType; label: string; icon: React.ReactNode }[] = [
  { key: "repos", label: "Repositories", icon: <RepoIcon size={16} /> },
  { key: "issues", label: "Issues", icon: <IssueOpenIcon size={16} /> },
  { key: "users", label: "Users", icon: <PersonIcon size={16} /> },
];

function TypeItem({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-fh-sm transition-colors",
        active
          ? "bg-fh-accent-muted font-semibold text-fh-fg"
          : "text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg",
      )}
    >
      <span className={cx("inline-flex shrink-0", active ? "text-fh-fg" : "text-fh-fg-muted")}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-fh-neutral-muted px-1.5 text-fh-xs font-semibold text-fh-fg-muted">
        {count}
      </span>
    </button>
  );
}

function IssueRow({ issue }: { issue: SearchIssueResult }) {
  const open = issue.state === "open";
  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-fh-surface-muted">
      <span className={cx("mt-0.5 shrink-0", open ? "text-fh-success-fg" : "text-fh-purple-fg")}>
        {open ? <IssueOpenIcon /> : <IssueClosedIcon />}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={`/${issue.repo.ownerHandle}/${issue.repo.name}/issues/${issue.number}`}
          className="text-fh-base font-semibold text-fh-fg hover:text-fh-accent-fg hover:underline"
        >
          {issue.title}
        </Link>
        <p className="mt-1 text-fh-xs text-fh-fg-subtle">
          <Link
            to={`/${issue.repo.ownerHandle}/${issue.repo.name}`}
            className="text-fh-fg-muted hover:text-fh-accent-fg hover:underline"
          >
            {issue.repo.ownerHandle}/{issue.repo.name}
          </Link>{" "}
          #{issue.number} · opened <RelativeTime date={issue.createdAt} /> by @{issue.author}
        </p>
      </div>
      <Badge tone={open ? "success" : "purple"}>{open ? "Open" : "Closed"}</Badge>
    </div>
  );
}

function UserRow({ result }: { result: SearchUserResult }) {
  const name = result.displayName || result.handle;
  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-fh-surface-muted">
      <Avatar name={name} size={40} />
      <div className="min-w-0 flex-1">
        <Link
          to={`/${result.handle}`}
          className="text-fh-base font-semibold text-fh-fg hover:text-fh-accent-fg hover:underline"
        >
          {name}
        </Link>
        <p className="text-fh-sm text-fh-fg-muted">@{result.handle}</p>
      </div>
      <span className="shrink-0 text-fh-xs text-fh-fg-subtle">
        Joined <RelativeTime date={result.createdAt} />
      </span>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <RowList aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton variant="circle" width={16} height={16} />
          <div className="flex-1 space-y-1.5">
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="text" width="60%" />
          </div>
        </div>
      ))}
    </RowList>
  );
}

export function SearchPage({ token, user, onLogout }: Props) {
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const type = (params.get("type") ?? "repos") as SearchType;
  const activeQuery = q.trim().length >= 2 ? q.trim() : "";

  const [inputValue, setInputValue] = useState(q);
  const [data, setData] = useState<SearchData>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInputValue(q);
  }, [q]);

  useEffect(() => {
    if (!activeQuery) {
      setData(EMPTY);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      search(token, activeQuery, "repos"),
      search(token, activeQuery, "issues"),
      search(token, activeQuery, "users"),
    ])
      .then(([repos, issues, users]) => {
        if (cancelled) return;
        if (repos.status === "rejected" && issues.status === "rejected" && users.status === "rejected") {
          const reason = repos.reason;
          setError(reason instanceof Error ? reason.message : "Search failed");
          setData(EMPTY);
          return;
        }
        setData({
          repos: repos.status === "fulfilled" ? (repos.value.results as SearchRepoResult[]) : [],
          issues: issues.status === "fulfilled" ? (issues.value.results as SearchIssueResult[]) : [],
          users: users.status === "fulfilled" ? (users.value.results as SearchUserResult[]) : [],
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeQuery, token]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setParams({ q: trimmed, type });
  }

  function switchType(t: SearchType) {
    setParams({ q, type: t });
  }

  const counts: Record<SearchType, number> = {
    repos: data.repos.length,
    issues: data.issues.length,
    users: data.users.length,
  };
  const activeCount = counts[type];

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6">
        {/* Search bar */}
        <form onSubmit={submit} className="mb-6 flex gap-2">
          <div className="relative w-full max-w-2xl flex-1">
            <Icons.SearchIcon
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fh-fg-muted"
            />
            <TextInput
              className="pl-9"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Search ForgeHub"
              aria-label="Search ForgeHub"
              autoFocus
            />
          </div>
          <Button type="submit" variant="primary">
            Search
          </Button>
        </form>

        {activeQuery ? (
          <div className="flex flex-col gap-6 md:flex-row">
            {/* Type filter sidebar */}
            <aside className="w-full flex-shrink-0 md:w-52">
              <p className="mb-2 px-3 text-fh-xs font-semibold uppercase tracking-wide text-fh-fg-subtle">
                Filter by
              </p>
              <nav className="flex flex-col gap-0.5">
                {TYPES.map((t) => (
                  <TypeItem
                    key={t.key}
                    active={type === t.key}
                    icon={t.icon}
                    label={t.label}
                    count={counts[t.key]}
                    onClick={() => switchType(t.key)}
                  />
                ))}
              </nav>
            </aside>

            {/* Results */}
            <div className="min-w-0 flex-1">
              <p className="mb-3 text-fh-sm text-fh-fg-muted" aria-live="polite">
                {loading
                  ? "Searching…"
                  : error
                    ? ""
                    : `${activeCount} ${activeCount === 1 ? "result" : "results"} for “${activeQuery}”`}
              </p>

              {loading && <ResultsSkeleton />}

              {!loading && error && (
                <div className="rounded-md border border-fh-border bg-fh-surface px-4 py-4 text-fh-sm text-fh-danger-fg">
                  {error}
                </div>
              )}

              {!loading && !error && type === "repos" &&
                (data.repos.length === 0 ? (
                  <EmptyState
                    bordered
                    icon={<RepoIcon size={28} />}
                    title="No repositories found"
                    description={`No repository matches “${activeQuery}”. Try a different term or search issues and users instead.`}
                  />
                ) : (
                  <RowList aria-label="Repository results">
                    {data.repos.map((r) => (
                      <RepoRow
                        key={r.id}
                        to={`/${r.ownerHandle}/${r.name}`}
                        name={`${r.ownerHandle}/${r.name}`}
                        description={r.description}
                        visibility={r.visibility}
                        updatedAt={r.updatedAt}
                        topics={r.topics}
                      />
                    ))}
                  </RowList>
                ))}

              {!loading && !error && type === "issues" &&
                (data.issues.length === 0 ? (
                  <EmptyState
                    bordered
                    icon={<IssueOpenIcon size={28} />}
                    title="No issues found"
                    description={`No issue matches “${activeQuery}”. Check the wording, or search repositories and users instead.`}
                  />
                ) : (
                  <RowList aria-label="Issue results">
                    {data.issues.map((i) => (
                      <IssueRow key={i.id} issue={i} />
                    ))}
                  </RowList>
                ))}

              {!loading && !error && type === "users" &&
                (data.users.length === 0 ? (
                  <EmptyState
                    bordered
                    icon={<PersonIcon size={28} />}
                    title="No users found"
                    description={`No user matches “${activeQuery}”. Try their handle, or search repositories and issues instead.`}
                  />
                ) : (
                  <RowList aria-label="User results">
                    {data.users.map((u) => (
                      <UserRow key={u.id} result={u} />
                    ))}
                  </RowList>
                ))}
            </div>
          </div>
        ) : (
          <EmptyState
            className="py-20"
            icon={<Icons.SearchIcon size={40} />}
            title="Search ForgeHub"
            description="Find repositories, issues, and users. Type at least two characters to begin."
          />
        )}
      </div>

      <Footer />
    </div>
  );
}
