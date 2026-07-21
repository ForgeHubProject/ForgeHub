import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { createRepo, getCollaboratingRepos, getMyRepos } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { Repo, User } from "../types";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icons,
  Skeleton,
  TextInput,
  Textarea,
  cx,
  useToast,
} from "../ui";
import { LockIcon, PlusIcon, RepoIcon, RepoRow, RowList } from "./listShared";

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

const CREATE_FORM_ID = "create-repo-form";

function repoHref(repo: Repo): string {
  return `/${repo.ownerHandle ?? ""}/${repo.name}`;
}

export function RepoListPage({ token, user, onLogout }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [collabRepos, setCollabRepos] = useState<Repo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>({ name: "", description: "", visibility: "private" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([getMyRepos(token), getCollaboratingRepos(token)])
      .then(([mine, collab]) => {
        setRepos(mine.repos);
        setCollabRepos(collab.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
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

  function openCreate() {
    setForm({ name: "", description: "", visibility: "private" });
    setCreateError(null);
    setShowCreate(true);
  }

  function closeCreate() {
    if (creating) return;
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
      setShowCreate(false);
      toast("Repository created", { tone: "success" });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
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
              <Link
                to={`/${user.handle}`}
                className="group flex items-center gap-3 no-underline"
              >
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
                    onClick={openCreate}
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
                  <Button variant="primary" leadingIcon={<PlusIcon size={14} />} onClick={openCreate}>
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

      <Dialog
        open={showCreate}
        onClose={closeCreate}
        title="Create a new repository"
        description="A repository contains all your project's files and their revision history."
        footer={
          <>
            <Button variant="default" onClick={closeCreate} disabled={creating}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={CREATE_FORM_ID}
              variant="primary"
              loading={creating}
              disabled={!form.name.trim()}
            >
              Create repository
            </Button>
          </>
        }
      >
        <form id={CREATE_FORM_ID} onSubmit={submitCreate} className="flex flex-col gap-4">
          <Field
            label="Repository name"
            required
            htmlFor="repo-name"
            hint="Lowercase letters, numbers, hyphens and dots only."
          >
            {(id) => (
              <TextInput
                id={id}
                placeholder="my-project"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
                required
              />
            )}
          </Field>

          <Field label="Description" htmlFor="repo-desc">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                placeholder="Short description of your project (optional)"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            )}
          </Field>

          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-fh-sm font-semibold text-fh-fg">Visibility</legend>
            {(["private", "public"] as const).map((v) => {
              const active = form.visibility === v;
              return (
                <label
                  key={v}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                    active
                      ? "border-fh-accent-emphasis bg-fh-accent-subtle"
                      : "border-fh-border hover:bg-fh-surface-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={v}
                    checked={active}
                    onChange={() => setForm((f) => ({ ...f, visibility: v }))}
                    className="mt-1 accent-fh-accent-emphasis"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-fh-sm font-semibold text-fh-fg">
                      {v === "private" ? <LockIcon size={14} /> : <RepoIcon size={14} />}
                      {v === "private" ? "Private" : "Public"}
                    </span>
                    <span className="mt-0.5 block text-fh-xs text-fh-fg-muted">
                      {v === "private"
                        ? "Only you and collaborators can see this repository."
                        : "Anyone on the internet can see this repository."}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {createError && (
            <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">
              {createError}
            </p>
          )}
        </form>
      </Dialog>
    </div>
  );
}
