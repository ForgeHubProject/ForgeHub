import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { search } from "../api";
import { Header } from "../components/Header";
import type { SearchIssueResult, SearchRepoResult, SearchUserResult, User } from "../types";

type Props = { token: string; user: User; onLogout: () => void };
type SearchType = "repos" | "issues" | "users";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const d = Math.floor(diff / 86400000);
  if (d < 1) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function RepoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
      <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
    </svg>
  );
}

function IssueIcon({ state }: { state: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={`flex-shrink-0 ${state === "open" ? "text-gh-success" : "text-gh-muted"}`}>
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="inline text-gh-muted">
      <path fillRule="evenodd" d="M4 4v2h-.25A1.75 1.75 0 002 7.75v5.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-5.5A1.75 1.75 0 0012.25 6H12V4a4 4 0 10-8 0zm6.5 2V4a2.5 2.5 0 00-5 0v2h5z" />
    </svg>
  );
}

function RepoResults({ results }: { results: SearchRepoResult[] }) {
  if (results.length === 0) {
    return <p className="text-sm text-gh-muted py-8 text-center">No repositories matched your search.</p>;
  }
  return (
    <div className="card divide-y divide-gh-border overflow-hidden">
      {results.map((r) => (
        <div key={r.id} className="px-4 py-3 hover:bg-gh-bg flex items-start gap-3">
          <RepoIcon />
          <div className="flex-1 min-w-0">
            <Link
              to={`/${r.ownerHandle}/${r.name}`}
              className="text-sm font-semibold text-gh-accent hover:underline no-underline"
            >
              {r.ownerHandle}/{r.name}
            </Link>
            {r.visibility === "private" && (
              <span className="ml-2 text-xs text-gh-muted"><LockIcon /> Private</span>
            )}
            {r.description && (
              <p className="text-xs text-gh-muted mt-0.5 truncate">{r.description}</p>
            )}
            <p className="text-xs text-gh-muted mt-1">Updated {timeAgo(r.updatedAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueResults({ results }: { results: SearchIssueResult[] }) {
  if (results.length === 0) {
    return <p className="text-sm text-gh-muted py-8 text-center">No issues matched your search.</p>;
  }
  return (
    <div className="card divide-y divide-gh-border overflow-hidden">
      {results.map((i) => (
        <div key={i.id} className="px-4 py-3 hover:bg-gh-bg flex items-start gap-3">
          <IssueIcon state={i.state} />
          <div className="flex-1 min-w-0">
            <Link
              to={`/${i.repo.ownerHandle}/${i.repo.name}/issues/${i.number}`}
              className="text-sm font-semibold text-gh-text hover:text-gh-accent hover:underline no-underline"
            >
              {i.title}
            </Link>
            <p className="text-xs text-gh-muted mt-0.5">
              <Link
                to={`/${i.repo.ownerHandle}/${i.repo.name}`}
                className="text-gh-accent hover:underline no-underline"
              >
                {i.repo.ownerHandle}/{i.repo.name}
              </Link>
              {" "}#{i.number} · opened {timeAgo(i.createdAt)} by @{i.author}
            </p>
          </div>
          <span className={`badge text-xs flex-shrink-0 ${i.state === "open" ? "text-gh-success border-gh-success" : "text-gh-muted"}`}>
            {i.state}
          </span>
        </div>
      ))}
    </div>
  );
}

function UserResults({ results }: { results: SearchUserResult[] }) {
  if (results.length === 0) {
    return <p className="text-sm text-gh-muted py-8 text-center">No users matched your search.</p>;
  }
  return (
    <div className="card divide-y divide-gh-border overflow-hidden">
      {results.map((u) => (
        <div key={u.id} className="px-4 py-3 hover:bg-gh-bg flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gh-accent flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
            {(u.displayName || u.handle)[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gh-text">{u.displayName || u.handle}</p>
            <p className="text-xs text-gh-muted">@{u.handle}</p>
          </div>
          <span className="text-xs text-gh-muted">Joined {timeAgo(u.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

export function SearchPage({ token, user, onLogout }: Props) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = params.get("q") ?? "";
  const type = (params.get("type") ?? "repos") as SearchType;

  const [inputValue, setInputValue] = useState(q);
  const [results, setResults] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputValue(q);
  }, [q]);

  useEffect(() => {
    if (!q || q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    search(token, q, type)
      .then((d) => setResults(d.results))
      .catch((e) => setError(e instanceof Error ? e.message : "Search failed"))
      .finally(() => setLoading(false));
  }, [q, type, token]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setParams({ q: trimmed, type });
  }

  function switchType(t: SearchType) {
    setParams({ q, type: t });
  }

  const tabs: { key: SearchType; label: string }[] = [
    { key: "repos", label: "Repositories" },
    { key: "issues", label: "Issues" },
    { key: "users", label: "Users" },
  ];

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[1280px] mx-auto px-4 py-6">
        {/* Search bar */}
        <form onSubmit={submit} className="mb-6">
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-2xl">
              <svg
                width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gh-muted pointer-events-none"
              >
                <path fillRule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z" />
              </svg>
              <input
                ref={inputRef}
                className="input pl-9 w-full"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Search ForgeHub…"
                autoFocus
              />
            </div>
            <button type="submit" className="btn-primary px-5">Search</button>
          </div>
        </form>

        {q && q.trim().length >= 2 ? (
          <div className="flex gap-6">
            {/* Sidebar type filter */}
            <aside className="w-44 flex-shrink-0">
              <p className="text-xs font-semibold text-gh-muted uppercase tracking-wide px-3 mb-2">Type</p>
              <ul className="space-y-0.5">
                {tabs.map((t) => (
                  <li key={t.key}>
                    <button
                      className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors ${
                        type === t.key
                          ? "font-semibold text-gh-text bg-gh-bg border border-gh-border"
                          : "text-gh-muted hover:text-gh-text hover:bg-gh-bg"
                      }`}
                      onClick={() => switchType(t.key)}
                    >
                      {t.label}
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            {/* Results */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gh-muted mb-3">
                {loading ? "Searching…" : error ? "" : `${results.length} result${results.length !== 1 ? "s" : ""} for "${q}"`}
              </p>

              {error && (
                <div className="card p-4 text-sm text-gh-danger">{error}</div>
              )}

              {!loading && !error && type === "repos" && (
                <RepoResults results={results as SearchRepoResult[]} />
              )}
              {!loading && !error && type === "issues" && (
                <IssueResults results={results as SearchIssueResult[]} />
              )}
              {!loading && !error && type === "users" && (
                <UserResults results={results as SearchUserResult[]} />
              )}

              {loading && (
                <div className="card divide-y divide-gh-border overflow-hidden animate-pulse">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-4 h-4 bg-gray-200 rounded" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-4 bg-gray-200 rounded w-2/5" />
                        <div className="h-3 bg-gray-100 rounded w-3/5" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-16 text-gh-muted">
            <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" className="mx-auto mb-4 opacity-30">
              <path fillRule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z" />
            </svg>
            <p className="text-base font-semibold text-gh-text">Search ForgeHub</p>
            <p className="text-sm mt-1">Find repositories, issues, and users.</p>
          </div>
        )}
      </div>
    </div>
  );
}
