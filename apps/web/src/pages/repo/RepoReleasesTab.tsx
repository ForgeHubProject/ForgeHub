import { useEffect, useState } from "react";
import { listReleases } from "../../api";
import type { Release, User } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
};

function TagIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}

function ReleaseBadges({ release }: { release: Release }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {release.isPrerelease && (
        <span className="badge bg-gh-warning-muted text-gh-warning border-transparent">Pre-release</span>
      )}
      {release.isDraft && (
        <span className="badge bg-gray-100 text-gh-muted border-transparent">Draft</span>
      )}
    </div>
  );
}

export function RepoReleasesTab({ token, handle, repoName, user }: Props) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listReleases(token, handle, repoName)
      .then((d) => setReleases(d.releases))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="card p-6 animate-pulse">
            <div className="h-5 bg-gray-200 rounded w-1/3 mb-3" />
            <div className="h-4 bg-gray-100 rounded w-1/4 mb-4" />
            <div className="h-3 bg-gray-100 rounded w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="card p-8 text-center text-gh-danger">{error}</div>;
  }

  if (releases.length === 0) {
    return (
      <div className="card p-16 text-center">
        <TagIcon />
        <p className="text-gh-lg font-semibold text-gh-text mt-3">No releases</p>
        <p className="text-gh-muted text-gh-sm mt-1">
          Releases are created from tags and let you package and distribute your software.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {releases.map((release, idx) => (
        <div key={release.id} className="card p-6">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {idx === 0 && !release.isDraft && !release.isPrerelease && (
                  <span className="badge bg-gh-success-muted text-gh-success border-transparent">Latest</span>
                )}
                <ReleaseBadges release={release} />
              </div>
              <h3 className="text-gh-xl font-semibold text-gh-text">{release.name || release.tagName}</h3>
              <div className="flex items-center gap-2 mt-1">
                <TagIcon />
                <code className="font-mono text-gh-sm text-gh-muted">{release.tagName}</code>
                <span className="text-gh-muted text-gh-xs">
                  {`Published ${new Date(release.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`}
                  {" by "}
                  <span className="font-medium text-gh-text">{release.author}</span>
                </span>
              </div>

              {release.body && (
                <div className="mt-4 pt-4 border-t border-gh-border">
                  <pre className="whitespace-pre-wrap text-gh-sm text-gh-text font-sans leading-relaxed">
                    {release.body}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
