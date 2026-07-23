import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listForks } from "../../api";
import type { ForkSummary } from "../../types";
import { Badge, EmptyState, RelativeTime, Skeleton } from "../../ui";

type Props = {
  token: string;
  handle: string;
  repoName: string;
};

function ForkGlyph({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
    </svg>
  );
}

function ForkRow({ fork }: { fork: ForkSummary }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-fh-border-muted last:border-b-0 hover:bg-fh-surface-muted/50">
      <ForkGlyph className="text-fh-fg-subtle shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/${fork.ownerHandle}/${fork.name}`}
            className="font-semibold text-fh-base text-fh-fg no-underline hover:text-fh-accent-fg hover:underline truncate"
          >
            {fork.fullName}
          </Link>
          {fork.visibility === "private" && (
            <Badge tone="warning" pill={false} className="text-fh-xs">Private</Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-fh-xs text-fh-fg-subtle min-w-0">
          {fork.description ? (
            <span className="truncate">{fork.description}</span>
          ) : (
            <span className="italic">No description</span>
          )}
          <span aria-hidden="true">·</span>
          <span className="truncate whitespace-nowrap">Updated <RelativeTime date={fork.updatedAt} /></span>
        </div>
      </div>
    </div>
  );
}

export function RepoForksTab({ token, handle, repoName }: Props) {
  const [forks, setForks] = useState<ForkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listForks(token, handle, repoName)
      .then((d) => setForks(d.forks))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load forks"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <ForkGlyph className="text-fh-fg-subtle" />
        <h2 className="text-fh-lg font-semibold text-fh-fg">Forks</h2>
        {!loading && !error && (
          <span className="text-fh-sm text-fh-fg-subtle tabular-nums">{forks.length}</span>
        )}
      </div>

      {loading ? (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-fh-border-muted last:border-b-0">
              <Skeleton variant="circle" className="w-4 h-4" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5" width={160 + i * 20} />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<ForkGlyph />} title="Couldn't load forks" description={error} />
        </div>
      ) : forks.length === 0 ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState
            icon={<ForkGlyph />}
            title="No forks yet"
            description="When someone forks this repository, it will show up here."
          />
        </div>
      ) : (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          {forks.map((f) => (
            <ForkRow key={f.id} fork={f} />
          ))}
        </div>
      )}
    </div>
  );
}
