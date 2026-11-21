import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOrgImports, retryImport, retryIssueImport, type OrgImportRepo } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { importPhase, stillGoing } from "../lib/orgImport";
import type { User } from "../types";
import { Badge, Button, EmptyState, Spinner, useToast } from "../ui";
import { importedSoFar } from "./repo/issues/IssueImportBanner";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

/** How often the page asks how the imports are going while any is under way. */
const POLL_MS = 5_000;

/** "14:20" in the viewer's time. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * An organization's imports from GitHub (#308): each repository waiting, importing,
 * failed (with Retry for owners) or imported, with its issues and pull requests
 * coming over after the code. Updates itself while anything is under way.
 */
export function OrgImportsPage({ token, user, onLogout }: Props) {
  const { handle = "" } = useParams<{ handle: string }>();
  const [repos, setRepos] = useState<OrgImportRepo[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    getOrgImports(token, handle)
      .then((res) => {
        if (!live) return;
        setRepos(res.repos);
        setOwner(res.viewerRole === "OWNER");
        setError(null);
        if (stillGoing(res.repos)) timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not load the imports"));
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, handle, tick]);

  const count = (phase: ReturnType<typeof importPhase>) => repos?.filter((r) => importPhase(r) === phase).length ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[880px] flex-1 px-4 py-8">
        <p className="text-fh-sm text-fh-fg-muted">
          <Link to={`/${handle}`} className="text-fh-accent-fg hover:underline">{handle}</Link>
        </p>
        <h1 className="text-fh-2xl font-semibold text-fh-fg">Imports from GitHub</h1>
        {repos && repos.length > 0 && (
          <p className="mt-1 text-fh-base text-fh-fg-muted" role="status">
            {count("imported")} of {repos.length} imported
            {count("importing") > 0 && <> · {count("importing")} importing</>}
            {count("waiting") > 0 && <> · {count("waiting")} waiting</>}
            {count("failed") > 0 && <> · {count("failed")} failed</>}
            {stillGoing(repos) && <>. They import one at a time; this page updates as they go.</>}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-6 rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
        )}
        {!repos && !error && (
          <div className="mt-6 flex justify-center"><Spinner /></div>
        )}
        {repos?.length === 0 && (
          <div className="mt-6">
            <EmptyState
              bordered
              title="Nothing imported yet"
              description="Repositories brought over from GitHub show here."
              actions={<Link to="/new/import/org"><Button variant="default">Import an organization</Button></Link>}
            />
          </div>
        )}
        {repos && repos.length > 0 && (
          <ul className="mt-6 divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
            {repos.map((r) => (
              <ImportRow key={r.name} token={token} handle={handle} repo={r} canRetry={owner} onChange={() => setTick((t) => t + 1)} />
            ))}
          </ul>
        )}
      </div>
      <Footer />
    </div>
  );
}

function ImportRow({ token, handle, repo, canRetry, onChange }: {
  token: string;
  handle: string;
  repo: OrgImportRepo;
  canRetry: boolean;
  onChange: () => void;
}) {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const phase = importPhase(repo);
  const issues = repo.issues;

  async function retry() {
    setRetrying(true);
    try {
      if (repo.status === "failed") await retryImport(token, handle, repo.name);
      else await retryIssueImport(token, handle, repo.name);
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't retry", { tone: "danger" });
    } finally {
      setRetrying(false);
    }
  }

  let detail: React.ReactNode = null;
  if (repo.status === "failed") detail = repo.error;
  else if (issues?.error) detail = <>Bringing the issues over stopped: {issues.error} {importedSoFar(issues)} came over before it stopped.</>;
  else if (repo.status === "done" && issues && issues.stage !== "done") {
    detail = issues.waitUntil
      ? <>{importedSoFar(issues)} so far. GitHub&apos;s requests for the hour are used up; it carries on at {clock(issues.waitUntil)}.</>
      : <>Code in. Bringing the issues over: {importedSoFar(issues)} so far.</>;
  } else if (phase === "imported" && issues) {
    detail = issues.issues + issues.pulls + issues.comments + issues.releases === 0
      ? "It had no issues, pull requests or releases."
      : importedSoFar(issues);
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Link to={`/${handle}/${repo.name}`} className="font-mono text-fh-sm font-semibold text-fh-accent-fg hover:underline">
            {repo.name}
          </Link>
          <PhaseBadge phase={phase} />
        </p>
        <p className="text-fh-xs text-fh-fg-muted">
          from{" "}
          <a href={`https://github.com/${repo.source}`} target="_blank" rel="noreferrer" className="hover:underline">
            github.com/{repo.source}
          </a>
        </p>
        {detail && <p className={`mt-1 text-fh-sm ${phase === "failed" ? "text-fh-danger-fg" : "text-fh-fg-muted"}`}>{detail}</p>}
      </div>
      {phase === "failed" && canRetry && (
        <Button size="sm" variant="default" loading={retrying} onClick={() => void retry()}>
          Retry
        </Button>
      )}
    </li>
  );
}

function PhaseBadge({ phase }: { phase: ReturnType<typeof importPhase> }) {
  switch (phase) {
    case "waiting":
      return <Badge tone="neutral" variant="outline">Waiting</Badge>;
    case "importing":
      return <Badge tone="accent" variant="outline"><Spinner size={10} /> Importing</Badge>;
    case "failed":
      return <Badge tone="danger" variant="outline">Failed</Badge>;
    default:
      return <Badge tone="success" variant="outline">Imported</Badge>;
  }
}
