import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listWatching, setWatchLevel, unwatchRepo } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import type { User, WatchLevel } from "../types";
import { EmptyState, PageHeading, Select, Skeleton, useToast } from "../ui";
import { RepoIcon } from "./listShared";
import { useDocumentTitle } from "./useDocumentTitle";

const LEVELS: Array<{ level: WatchLevel; label: string }> = [
  { level: "all", label: "All activity" },
  { level: "participating", label: "Participating and @mentions" },
  { level: "ignore", label: "Ignore" },
];

/**
 * Watching (#258): every repository whose activity reaches your inbox, and
 * how much of it. Repositories you own or collaborate on are watched until you
 * say otherwise.
 */
export function WatchingPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Watching · ForgeHub");
  const [repos, setRepos] = useState<Array<{ repo: string; level: WatchLevel; explicit: boolean }> | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    listWatching(token).then((d) => setRepos(d.repos)).catch(() => setRepos([]));
  }, [token]);

  async function change(repo: string, level: WatchLevel | "default") {
    const [h, n] = repo.split("/");
    try {
      const res = level === "default" ? await unwatchRepo(token, h, n) : await setWatchLevel(token, h, n, level);
      setRepos((prev) => (prev ?? []).map((r) => (r.repo === repo ? { ...r, level: res.watchLevel, explicit: level !== "default" } : r)));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't change watching", { tone: "danger" });
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[900px] flex-1 px-4 py-8">
        <p className="mb-2 text-fh-sm">
          <Link to="/notifications" className="text-fh-accent-fg hover:underline">Notifications</Link> / Watching
        </p>
        <PageHeading
          title="Watching"
          description="Repositories whose activity reaches your inbox. Change how much of each you hear about."
          divider
        />
        {repos === null ? (
          <Skeleton width="100%" height={120} />
        ) : repos.length === 0 ? (
          <EmptyState bordered icon={<RepoIcon size={28} />} title="You're not watching any repositories" description="Watch a repository from its page to hear about its activity." />
        ) : (
          <ul className="divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
            {repos.map((r) => (
              <li key={r.repo} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <RepoIcon size={16} className="shrink-0 text-fh-fg-muted" />
                <Link to={`/${r.repo}`} className="min-w-0 flex-1 truncate font-semibold text-fh-accent-fg hover:underline">{r.repo}</Link>
                {!r.explicit && <span className="text-fh-xs text-fh-fg-muted">by default</span>}
                <Select sizing="sm" aria-label={`Watching ${r.repo}`} value={r.level} onChange={(e) => void change(r.repo, e.target.value as WatchLevel)}>
                  {LEVELS.map((l) => (
                    <option key={l.level} value={l.level}>{l.label}</option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Footer />
    </div>
  );
}
