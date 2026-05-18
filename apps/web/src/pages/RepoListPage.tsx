import { useEffect, useState } from "react";
import { createRepo, getCollaboratingRepos, getMyRepos } from "../api";
import { Header } from "../components/Header";
import type { Repo, User } from "../types";

type Props = {
  token: string;
  user: User;
  onSelectRepo: (repo: Repo) => void;
  onLogout: () => void;
};

type CreateForm = {
  name: string;
  description: string;
  visibility: "public" | "private";
};

function RepoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
      <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z" />
    </svg>
  );
}

function RepoRow({ repo, onSelect, collab }: { repo: Repo; onSelect: (r: Repo) => void; collab?: boolean }) {
  return (
    <div className="py-5 flex items-start gap-3">
      <RepoIcon />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="text-gh-accent font-semibold text-gh-lg hover:underline bg-transparent border-none cursor-pointer p-0 text-left"
            onClick={() => onSelect(repo)}
          >
            {collab ? (repo.fullName ?? `${repo.ownerHandle}/${repo.name}`) : repo.name}
          </button>
          <span className={repo.visibility === "public" ? "badge-public" : "badge-private"}>
            {repo.visibility === "public" ? "Public" : "Private"}
          </span>
        </div>
        {repo.description && (
          <p className="text-gh-sm text-gh-muted mt-1 line-clamp-1">{repo.description}</p>
        )}
      </div>
    </div>
  );
}

export function RepoListPage({ token, user, onSelectRepo, onLogout }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [collabRepos, setCollabRepos] = useState<Repo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>({ name: "", description: "", visibility: "private" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getMyRepos(token), getCollaboratingRepos(token)])
      .then(([mine, collab]) => {
        setRepos(mine.repos);
        setCollabRepos(collab.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token]);

  function openCreate() {
    setForm({ name: "", description: "", visibility: "private" });
    setCreateError(null);
    setShowCreate(true);
  }

  function closeCreate() {
    setShowCreate(false);
    setCreateError(null);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const repo = await createRepo(token, form.name, form.description || undefined, form.visibility);
      setRepos((prev) => [repo, ...prev]);
      closeCreate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[1200px] mx-auto px-4 py-8">
        <div className="flex flex-col sm:flex-row gap-6">
          {/* Left sidebar */}
          <aside className="w-full sm:w-[296px] flex-shrink-0">
            {/* User profile card */}
            <div className="flex flex-col items-center sm:items-start">
              <div className="w-20 h-20 sm:w-[296px] sm:h-[296px] rounded-full sm:rounded-xl bg-gh-accent flex items-center justify-center text-white text-4xl font-semibold mb-3">
                {(user.displayName || user.handle)[0].toUpperCase()}
              </div>
              <h2 className="text-gh-xl font-semibold text-gh-text">{user.displayName || user.handle}</h2>
              <p className="text-gh-lg text-gh-muted">@{user.handle}</p>
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">
            {/* Tab bar */}
            <div className="tab-nav mb-4">
              <span className="tab-item-active">
                <RepoIcon />
                Repositories
                <span className="counter">{repos.length + collabRepos.length}</span>
              </span>
            </div>

            {/* Filter / create row */}
            <div className="flex gap-2 mb-4">
              <input
                className="input flex-1"
                placeholder="Find a repository…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button className="btn-primary px-4 whitespace-nowrap" onClick={openCreate}>
                New
              </button>
            </div>

            {/* Repo list */}
            {loading && (
              <div className="text-gh-muted text-gh-base py-8 text-center">Loading…</div>
            )}
            {error && (
              <div className="text-gh-danger text-gh-sm py-4">{error}</div>
            )}
            {(() => {
              const q = filter.toLowerCase();
              const filteredOwn = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
              const filteredCollab = q ? collabRepos.filter((r) => r.name.toLowerCase().includes(q) || r.ownerHandle?.toLowerCase().includes(q)) : collabRepos;
              return (
                <>
                  {filteredOwn.map((repo) => <RepoRow key={repo.id} repo={repo} onSelect={onSelectRepo} />)}
                  {filteredCollab.length > 0 && (
                    <>
                      <p className="text-xs font-semibold text-gh-muted uppercase tracking-wide mt-6 mb-1 px-0.5">Collaborating on</p>
                      <div className="divide-y divide-gh-border border-t border-gh-border">
                        {filteredCollab.map((repo) => <RepoRow key={repo.id} repo={repo} onSelect={onSelectRepo} collab />)}
                      </div>
                    </>
                  )}
                  {filteredOwn.length === 0 && filteredCollab.length === 0 && filter && (
                    <p className="text-sm text-gh-muted py-8 text-center">No repositories match "{filter}"</p>
                  )}
                </>
              );
            })()}

            {!loading && repos.length === 0 && collabRepos.length === 0 && !filter && !error && (
              <div className="text-center py-16 text-gh-muted">
                <RepoIcon />
                <p className="mt-3 text-gh-lg font-semibold text-gh-text">No repositories yet</p>
                <p className="text-gh-sm mt-1">Create your first repository to get started.</p>
                <button className="btn-primary mt-4 px-4 py-2" onClick={openCreate}>
                  Create a repository
                </button>
              </div>
            )}

          </main>
        </div>
      </div>

      {/* Create repo modal */}
      {showCreate && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
          onClick={closeCreate}
        >
          <div
            className="bg-gh-canvas border border-gh-border rounded-xl w-full max-w-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border">
              <h3 className="text-gh-lg font-semibold text-gh-text">Create a new repository</h3>
              <button
                className="text-gh-muted hover:text-gh-text bg-transparent border-none cursor-pointer p-1 rounded-md hover:bg-gh-bg"
                onClick={closeCreate}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </div>

            <form onSubmit={submitCreate} className="px-6 py-5 flex flex-col gap-4">
              <div className="form-group">
                <label className="label" htmlFor="repo-name">
                  Repository name <span className="text-gh-danger">*</span>
                </label>
                <input
                  id="repo-name"
                  className="input"
                  placeholder="my-project"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoFocus
                  required
                />
                <p className="text-gh-xs text-gh-muted mt-1">Lowercase letters, numbers, hyphens and dots only.</p>
              </div>

              <div className="form-group">
                <label className="label" htmlFor="repo-desc">
                  Description <span className="text-gh-muted font-normal">(optional)</span>
                </label>
                <textarea
                  id="repo-desc"
                  className="input resize-none"
                  placeholder="Short description of your project"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                />
              </div>

              <div className="form-group">
                <label className="label">Visibility</label>
                <div className="flex flex-col gap-2">
                  {(["private", "public"] as const).map((v) => (
                    <label
                      key={v}
                      className={`flex items-start gap-3 p-3 border rounded-md cursor-pointer transition-colors ${
                        form.visibility === v
                          ? "border-gh-accent bg-gh-accent-muted"
                          : "border-gh-border hover:bg-gh-bg"
                      }`}
                    >
                      <input
                        type="radio"
                        name="visibility"
                        value={v}
                        checked={form.visibility === v}
                        onChange={() => setForm((f) => ({ ...f, visibility: v }))}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="block text-gh-sm font-semibold text-gh-text">
                          {v === "private" ? "Private" : "Public"}
                        </span>
                        <span className="block text-gh-xs text-gh-muted mt-0.5">
                          {v === "private"
                            ? "Only you and collaborators can see it"
                            : "Anyone on the internet can see this repository"}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {createError && (
                <p className="text-gh-danger text-gh-sm bg-gh-danger-muted rounded-md px-3 py-2">
                  {createError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-gh-border">
                <button type="button" className="btn-default" onClick={closeCreate}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary px-4"
                  disabled={creating || !form.name.trim()}
                >
                  {creating ? "Creating…" : "Create repository"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
