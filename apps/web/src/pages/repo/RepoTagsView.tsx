import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { downloadArchive, listTags, type TagInfo } from "../../api";
import { EmptyState, RelativeTime, Skeleton, cx, useToast } from "../../ui";

/** GitHub's Releases | Tags switch above both lists (#256). */
export function ReleasesTagsSwitch({ base, active, counts }: { base: string; active: "releases" | "tags"; counts?: { releases?: number; tags?: number } }) {
  return (
    <div role="tablist" aria-label="Releases and tags" className="inline-flex overflow-hidden rounded-md border border-fh-border">
      {(["releases", "tags"] as const).map((t, i) => (
        <Link
          key={t}
          to={`${base}/${t}`}
          role="tab"
          aria-selected={active === t}
          className={cx(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-fh-sm no-underline",
            i > 0 && "border-l border-fh-border",
            active === t ? "bg-fh-accent-emphasis text-white font-semibold" : "bg-fh-surface text-fh-fg hover:bg-fh-surface-muted",
          )}
        >
          {t === "releases" ? "Releases" : "Tags"}
          {counts?.[t] != null && <span className="text-fh-xs opacity-80">{counts[t]}</span>}
        </Link>
      ))}
    </div>
  );
}

/** The repository's tags (#256): each with its commit, date, and zip download. */
export function RepoTagsView({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const base = `/${handle}/${repoName}`;
  const { toast } = useToast();
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTags(token, handle, repoName)
      .then((d) => setTags(d.tags))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load tags"));
  }, [token, handle, repoName]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <ReleasesTagsSwitch base={base} active="tags" counts={{ tags: tags?.length }} />
      </div>
      {tags === null && !error ? (
        <div className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-4 py-3 space-y-2"><Skeleton variant="text" width="30%" /><Skeleton variant="text" width="50%" /></div>
          ))}
        </div>
      ) : error ? (
        <EmptyState bordered title="Couldn't load tags" description={error} />
      ) : tags!.length === 0 ? (
        <EmptyState bordered title="There aren't any tags yet" description="Tags mark a commit, usually for a release. Push one with git tag, or create one with a release." />
      ) : (
        <ul className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border">
          {tags!.map((t) => (
            <li key={t.name} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link to={`${base}/tree/${t.name}`} className="font-semibold text-fh-base text-fh-fg hover:text-fh-accent-fg">{t.name}</Link>
                {t.date && <span className="text-fh-xs text-fh-fg-muted"><RelativeTime date={t.date} /></span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-fh-xs text-fh-fg-muted">
                <Link to={`${base}/commits/${t.sha}`} className="font-mono text-fh-fg-muted hover:text-fh-accent-fg">{t.sha.slice(0, 7)}</Link>
                {t.subject && <span className="truncate max-w-md">{t.subject}</span>}
                <button
                  type="button"
                  onClick={() => downloadArchive(token, handle, repoName, t.name).catch(() => toast("Download failed", { tone: "danger" }))}
                  className="text-fh-accent-fg hover:underline"
                >
                  zip
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
