import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getFeed } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { FeedItem, User } from "../types";
import { Avatar, Button, EmptyState, PageHeading, RelativeTime, Skeleton } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

// ── local Octicon-style marks ─────────────────────────────────────────────────

function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const ISSUE = "M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z";
const PR = "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z";
const MERGE = "M5.45 5.154A4.25 4.25 0 009.25 7.5h1.378a2.251 2.251 0 110 1.5H9.25A5.734 5.734 0 015 7.123v3.505a2.25 2.25 0 11-1.5 0V5.372a2.25 2.25 0 111.95-.218zM4.25 13.5a.75.75 0 100-1.5.75.75 0 000 1.5zm8.5-4.5a.75.75 0 100-1.5.75.75 0 000 1.5zM5 3.25a.75.75 0 10-1.5 0 .75.75 0 001.5 0z";
const TAG = "M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z";
const CLOSED = "M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 10-13 0 6.5 6.5 0 0013 0z";
const PULSE = "M6 2c.306 0 .582.187.696.471L10 10.731l1.304-3.26A.751.751 0 0112 7h3.25a.75.75 0 010 1.5h-2.742l-1.812 4.528a.751.751 0 01-1.392 0L6 4.77 4.696 8.03A.75.75 0 014 8.5H.75a.75.75 0 010-1.5h2.742l1.812-4.529A.751.751 0 016 2z";

/** Icon + tone for one feed entry, keyed by its type/kind. */
function itemMark(item: FeedItem): { path: string; tone: string } {
  switch (item.type) {
    case "issue_opened": return { path: ISSUE, tone: "text-fh-success-fg" };
    case "pr_opened": return { path: PR, tone: "text-fh-success-fg" };
    case "release": return { path: TAG, tone: "text-fh-purple-fg" };
    case "timeline":
      if (item.kind === "merged") return { path: MERGE, tone: "text-fh-purple-fg" };
      if (item.kind === "reopened") return { path: ISSUE, tone: "text-fh-success-fg" };
      return { path: CLOSED, tone: "text-fh-purple-fg" };
  }
}

/** The verb + subject-link sentence body for one entry. */
function ItemBody({ item }: { item: FeedItem }) {
  const base = `/${item.repo.ownerHandle}/${item.repo.name}`;
  const subjectPath = item.subjectType === "pull_request" || item.type === "pr_opened" ? "pulls" : "issues";
  const ref = item.number != null
    ? `${subjectPath === "pulls" ? "!" : "#"}${item.number}`
    : "";
  const subjectLink = item.number != null && (
    <Link to={`${base}/${subjectPath}/${item.number}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">
      {ref}{item.title ? ` ${item.title}` : ""}
    </Link>
  );

  switch (item.type) {
    case "issue_opened":
      return <>opened issue {subjectLink}</>;
    case "pr_opened":
      return <>opened pull request {subjectLink}</>;
    case "release":
      return (
        <>
          published release{" "}
          <Link to={`${base}/releases`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">
            {item.releaseName || item.tagName}
          </Link>{" "}
          <span className="font-mono text-fh-xs text-fh-fg-subtle">{item.tagName}</span>
        </>
      );
    case "timeline": {
      const verb = item.kind === "merged" ? "merged" : item.kind === "reopened" ? "reopened" : "closed";
      return <>{verb} {item.subjectType === "pull_request" ? "pull request" : "issue"} {subjectLink}</>;
    }
  }
}

export function FeedPage({ token, user, onLogout }: Props) {
  useDocumentTitle("Feed · ForgeHub");
  const [items, setItems] = useState<FeedItem[]>([]);
  // Cursor, not a page number: the feed is a live stream, and an offset would
  // shift under new activity — re-appending entries already on screen.
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getFeed(token)
      .then((d) => {
        setItems(d.items);
        setCursor(d.nextCursor);
        setHasMore(d.hasMore);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load the feed"))
      .finally(() => setLoading(false));
  }, [token]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await getFeed(token, cursor);
      setItems((prev) => [...prev, ...d.items]);
      setCursor(d.nextCursor);
      setHasMore(d.hasMore);
    } catch {
      // Keep what we have; the button stays for a retry.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="flex-1 w-full max-w-[1000px] mx-auto px-4 py-8">
        <PageHeading
          title="Feed"
          icon={<Icon path={PULSE} size={20} />}
          description="Recent activity across the repositories you watch and star."
        />

        <div className="mt-5">
          {loading ? (
            <div className="bg-fh-surface border border-fh-border rounded-md divide-y divide-fh-border">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton variant="block" width={28} height={28} className="rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="bg-fh-surface border border-fh-border rounded-md">
              <EmptyState icon={<Icon path={PULSE} size={32} />} title="Couldn't load the feed" description={error} />
            </div>
          ) : items.length === 0 ? (
            <div className="bg-fh-surface border border-fh-border rounded-md">
              <EmptyState
                icon={<Icon path={PULSE} size={32} />}
                title="Nothing here yet"
                description="Star or watch repositories and their activity — new issues, pull requests, merges, and releases — will show up here."
              />
            </div>
          ) : (
            <>
              <div className="bg-fh-surface border border-fh-border rounded-md overflow-hidden divide-y divide-fh-border">
                {items.map((item) => {
                  const mark = itemMark(item);
                  return (
                    <div key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-fh-surface-muted transition-colors">
                      <span className={`flex items-center justify-center shrink-0 w-7 h-7 rounded-full bg-fh-surface-muted ${mark.tone}`}>
                        <Icon path={mark.path} size={15} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-fh-sm text-fh-fg-muted leading-snug break-words">
                          <Avatar name={item.actor} size={16} className="inline-block align-text-bottom mr-1" />
                          <Link to={`/${item.actor}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">
                            {item.actor}
                          </Link>{" "}
                          <ItemBody item={item} />
                        </p>
                        <p className="mt-0.5 text-fh-xs text-fh-fg-subtle">
                          <Link
                            to={`/${item.repo.ownerHandle}/${item.repo.name}`}
                            className="text-fh-accent-fg hover:underline"
                          >
                            {item.repo.ownerHandle}/{item.repo.name}
                          </Link>{" "}
                          · <RelativeTime date={item.createdAt} />
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <div className="mt-4 flex justify-center">
                  <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Footer />
    </div>
  );
}
