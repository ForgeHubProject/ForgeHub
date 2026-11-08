import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { exploreFormats, exploreRepos, exploreTopics } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { FORMAT_FAMILY_LABELS, formatLabel } from "../lib/formats";
import type { ExploreRepo, User } from "../types";
import { Button, EmptyState, Skeleton, TabItem, TabNav, cx } from "../ui";
import { RepoIcon, RepoRow, RowList, topicHref } from "./listShared";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Explore (/explore) and a topic's page (/topics/:topic) (#257): public
 * repositories, popular or recently updated, narrowed by what kind of files
 * they hold, which is what sets ForgeHub apart.
 */
export function ExplorePage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  const { topic } = useParams<{ topic?: string }>();
  useDocumentTitle(topic ? `Topic: ${topic} · ForgeHub` : "Explore · ForgeHub");
  const [params, setParams] = useSearchParams();
  const sort = params.get("sort") === "updated" ? "updated" : "stars";
  const format = params.get("format") ?? "";
  const [repos, setRepos] = useState<ExploreRepo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formats, setFormats] = useState<Array<{ id: string; count: number }>>([]);
  const [topics, setTopics] = useState<Array<{ topic: string; count: number }>>([]);

  useEffect(() => {
    let live = true;
    setRepos(null);
    setError(null);
    setPage(1);
    exploreRepos(token, { sort, format: format || undefined, topic })
      .then((d) => {
        if (!live) return;
        setRepos(d.repos);
        setTotal(d.total);
        setHasMore(d.hasMore);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load repositories"));
    return () => {
      live = false;
    };
  }, [token, sort, format, topic]);

  useEffect(() => {
    exploreFormats(token).then((d) => setFormats(d.formats)).catch(() => setFormats([]));
    exploreTopics(token).then((d) => setTopics(d.topics)).catch(() => setTopics([]));
  }, [token]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const d = await exploreRepos(token, { sort, format: format || undefined, topic, page: page + 1 });
      setRepos((prev) => [...(prev ?? []), ...d.repos]);
      setHasMore(d.hasMore);
      setPage(page + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const formatsHeld = formats.filter((f) => f.count > 0 || f.id === format);

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8">
        <div className="mb-6">
          {topic ? (
            <>
              <p className="text-fh-sm text-fh-fg-muted">
                <Link to="/explore" className="text-fh-accent-fg hover:underline">Explore</Link> / Topics
              </p>
              <h1 className="mt-1 text-fh-2xl font-semibold text-fh-fg">#{topic}</h1>
              <p className="mt-1 text-fh-base text-fh-fg-muted">
                {repos === null ? " " : `${total} public ${total === 1 ? "repository" : "repositories"} with this topic`}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-fh-2xl font-semibold text-fh-fg">Explore</h1>
              <p className="mt-1 text-fh-base text-fh-fg-muted">
                Public repositories on this ForgeHub, and the kinds of files they hold.
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          <main className="min-w-0 flex-1">
            {formatsHeld.length > 0 && (
              <div role="group" aria-label="Format" className="mb-4 flex flex-wrap gap-2">
                <FormatChip active={!format} onClick={() => setParam("format", null)}>All formats</FormatChip>
                {formatsHeld.map((f) => (
                  <FormatChip key={f.id} active={format === f.id} onClick={() => setParam("format", f.id)} count={topic ? undefined : f.count}>
                    {FORMAT_FAMILY_LABELS[f.id] ?? f.id}
                  </FormatChip>
                ))}
              </div>
            )}

            <TabNav aria-label="Sort" className="mb-4">
              <TabItem active={sort === "stars"} onClick={() => setParam("sort", null)}>Popular</TabItem>
              <TabItem active={sort === "updated"} onClick={() => setParam("sort", "updated")}>Recently updated</TabItem>
            </TabNav>

            {error && <p className="mb-4 rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>}

            {repos === null ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} width="100%" height={72} />)}
              </div>
            ) : repos.length === 0 ? (
              <EmptyState
                bordered
                icon={<RepoIcon size={28} />}
                title="No public repositories here yet"
                description={format ? `None hold ${FORMAT_FAMILY_LABELS[format] ?? format} files${topic ? " with this topic" : ""}.` : undefined}
                actions={format ? <Button variant="default" onClick={() => setParam("format", null)}>Show all formats</Button> : undefined}
              />
            ) : (
              <>
                <RowList aria-label="Repositories">
                  {repos.map((r) => (
                    <RepoRow
                      key={r.id}
                      to={`/${r.ownerHandle}/${r.name}`}
                      name={r.fullName ?? r.name}
                      description={r.description}
                      updatedAt={r.updatedAt}
                      topics={r.topics}
                      meta={
                        <>
                          <span>★ {r.starCount ?? 0}</span>
                          {r.formats.slice(0, 4).map((f) => (
                            <span key={f} className="rounded-full border border-fh-border px-1.5 text-fh-fg-muted">{formatLabel(f)}</span>
                          ))}
                        </>
                      }
                    />
                  ))}
                </RowList>
                {hasMore && (
                  <div className="mt-4 text-center">
                    <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>Load more</Button>
                  </div>
                )}
              </>
            )}
          </main>

          {topics.length > 0 && (
            <aside className="w-full flex-shrink-0 lg:w-[296px]" aria-label="Popular topics">
              <h2 className="mb-3 text-fh-base font-semibold text-fh-fg">Popular topics</h2>
              <ul className="flex flex-wrap gap-2">
                {topics.map((t) => (
                  <li key={t.topic}>
                    <Link
                      to={topicHref(t.topic)}
                      className={cx(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-fh-sm font-medium",
                        t.topic === topic
                          ? "bg-fh-accent-emphasis text-fh-on-emphasis"
                          : "bg-fh-accent-muted text-fh-accent-fg hover:bg-fh-accent-emphasis hover:text-fh-on-emphasis",
                      )}
                    >
                      {t.topic}
                      <span className="text-fh-xs opacity-80">{t.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}

function FormatChip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-fh-sm",
        active
          ? "border-fh-accent-emphasis bg-fh-accent-muted font-semibold text-fh-fg"
          : "border-fh-border bg-fh-surface text-fh-fg-muted hover:text-fh-fg",
      )}
    >
      {children}
      {count != null && <span className="text-fh-xs text-fh-fg-subtle">{count}</span>}
    </button>
  );
}
