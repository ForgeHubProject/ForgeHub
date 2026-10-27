import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCommits } from "../api";
import type { CommitInfo, FileDiff } from "../types";
import { needsFileDiffMeta } from "../lib/computeTier";
import { FhrFileDiffViewer } from "../views/diffViewers/FhrFileDiffViewer";
import { ComputeTierPill, useComputeTier, useFileDiffMeta } from "../views/diffViewers/computeTierUi";
import { extensionForFilename } from "../views/fileDiffViewerRegistry";

/**
 * The body of a binary file's page when its format has semantic diffs but its
 * renderer draws diffs only (a .figcraft design): there is no text to show, so
 * it shows what changed — the file at its latest commit against that commit's
 * parent, drawn by the same viewer and compute tiers a pull request uses. A
 * file the commit added diffs against nothing, so it reads as all added.
 */
export function LatestFileChange({ token, handle, repoName, repoBase, gitRef, path }: {
  token: string | null;
  handle: string;
  repoName: string;
  repoBase: string;
  gitRef: string;
  path: string;
}) {
  const [commit, setCommit] = useState<CommitInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setCommit(undefined);
    listCommits(token, handle, repoName, gitRef, { path, perPage: 1 })
      .then(({ commits }) => { if (live) setCommit(commits[0] ?? null); })
      .catch(() => { if (live) setCommit(null); });
    return () => { live = false; };
  }, [token, handle, repoName, gitRef, path]);

  const filename = path.split("/").pop() ?? path;
  const [tier, changeTier] = useComputeTier(extensionForFilename(filename));
  // The pill's metadata only once it is engaged, as on a pull request.
  const [pillEngaged, setPillEngaged] = useState(false);
  const meta = useFileDiffMeta(
    token,
    repoBase,
    path,
    commit?.sha ?? gitRef,
    commit != null && needsFileDiffMeta({ semantic: true, pillEngaged }),
  );

  if (commit === undefined) {
    return <div className="p-4 text-fh-sm text-fh-fg-subtle">Loading the latest change…</div>;
  }
  if (commit === null) {
    return <div className="p-4 text-fh-sm text-fh-fg-subtle">No commit information for this file.</div>;
  }
  const file: FileDiff = { oldPath: path, newPath: path, status: "modified", additions: 0, deletions: 0, binary: true, hunks: [] };
  return (
    <div data-testid="latest-file-change">
      <div className="flex min-w-0 items-center gap-2 border-b border-fh-border px-4 py-2 text-fh-sm">
        <span className="shrink-0 text-fh-fg-muted">What changed in</span>
        <Link
          to={`${repoBase}/commits/${commit.sha}`}
          className="shrink-0 rounded border border-fh-border bg-fh-surface px-1.5 py-0.5 font-mono text-fh-xs text-fh-fg-muted no-underline hover:border-fh-border-strong hover:text-fh-accent-fg"
          title={`View commit ${commit.sha}`}
        >
          {commit.shortSha}
        </Link>
        <span className="min-w-0 flex-1 truncate text-fh-fg" title={commit.subject}>{commit.subject}</span>
        <span className="shrink-0 text-fh-xs font-mono">
          <ComputeTierPill tier={tier} onChange={changeTier} meta={meta} onActivate={() => setPillEngaged(true)} />
        </span>
      </div>
      <FhrFileDiffViewer
        file={file}
        repoBase={repoBase}
        headRef={commit.sha}
        token={token}
        computeTier={tier}
        onComputeTierChange={changeTier}
      />
    </div>
  );
}
