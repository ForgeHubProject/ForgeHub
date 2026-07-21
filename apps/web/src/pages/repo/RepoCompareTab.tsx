import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPull, getRefCompare, getRefCompareDiff } from "../../api";
import type { BranchInfo, CommitInfo, FileDiff, RefCompareResult, User } from "../../types";
import { Avatar, Button, EmptyState, RelativeTime, Select, Skeleton, useToast } from "../../ui";
import { DiffCounts, DiffStatBar, ShaChip } from "./commitUi";
import { FileDiffCard } from "./RepoCommitsTab";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  branches: BranchInfo[];
  defaultBranch: string;
  user: User;
  splat: string;
  base: string;
};

function CompareGlyph({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
    </svg>
  );
}

/** Parse `compare/BASE...HEAD` (either segment may be URL-encoded and contain slashes). */
function parseCompareSplat(splat: string): { base: string; head: string } {
  const rest = splat.startsWith("compare/") ? splat.slice("compare/".length) : "";
  const idx = rest.indexOf("...");
  if (idx === -1) return { base: "", head: "" };
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { base: dec(rest.slice(0, idx)), head: dec(rest.slice(idx + 3)) };
}

function CommitList({ commits, base }: { commits: CommitInfo[]; base: string }) {
  return (
    <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface divide-y divide-fh-border-muted">
      {commits.map((c) => (
        <div key={c.sha} className="flex items-center gap-3 px-4 py-2.5 hover:bg-fh-surface-muted/50">
          <Avatar name={c.authorName} size={22} title={c.authorEmail} />
          <Link
            to={`${base}/commits/${c.sha}`}
            className="min-w-0 flex-1 truncate text-fh-sm text-fh-fg no-underline hover:text-fh-accent-fg"
            title={c.subject}
          >
            {c.subject}
          </Link>
          <span className="hidden sm:block text-fh-xs text-fh-fg-subtle shrink-0"><RelativeTime date={c.date} /></span>
          <ShaChip sha={c.sha} />
        </div>
      ))}
    </div>
  );
}

export function RepoCompareTab({ token, handle, repoName, branches, defaultBranch, user, splat, base }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const parsed = useMemo(() => parseCompareSplat(splat), [splat]);

  const branchNames = branches.map((b) => b.name);
  const firstOther = branches.find((b) => !b.isDefault)?.name ?? "";
  const baseRef = parsed.base || defaultBranch;
  const headRef = parsed.head || firstOther;

  const [result, setResult] = useState<RefCompareResult | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const bothChosen = Boolean(baseRef && headRef);
  const sameRef = baseRef === headRef;

  function setRefs(nextBase: string, nextHead: string) {
    navigate(`${base}/compare/${encodeURIComponent(nextBase)}...${nextHead}`);
  }

  useEffect(() => {
    if (!bothChosen || sameRef) { setResult(null); setDiffs(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiffs(null);
    getRefCompare(token, handle, repoName, baseRef, headRef)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Comparison failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // Full per-file diffs (separate call so the summary paints immediately).
    getRefCompareDiff(token, handle, repoName, baseRef, headRef)
      .then((d) => { if (!cancelled) setDiffs(d.files); })
      .catch(() => { if (!cancelled) setDiffs([]); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, baseRef, headRef, bothChosen, sameRef]);

  const headIsBranch = branchNames.includes(headRef);
  const baseIsBranch = branchNames.includes(baseRef);
  const canOpenPr = headIsBranch && baseIsBranch && !sameRef && (result?.ahead ?? 0) > 0;

  async function openPullRequest() {
    if (!result || !canOpenPr) return;
    setCreating(true);
    try {
      const title = result.commits[0]?.subject || `${headRef} into ${baseRef}`;
      const pr = await createPull(token, handle, repoName, title, headRef, baseRef);
      toast(`Pull request #${pr.number} opened`, { tone: "success" });
      navigate(`${base}/pulls/${pr.number}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not open pull request", { tone: "danger" });
    } finally {
      setCreating(false);
    }
  }

  const totalAdd = diffs?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDel = diffs?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <CompareGlyph className="text-fh-fg-subtle" />
        <h2 className="text-fh-lg font-semibold text-fh-fg">Compare changes</h2>
      </div>
      <p className="text-fh-sm text-fh-fg-muted mb-4">
        Compare two refs to see what changed. The base is what you merge into; the compare branch holds the new work.
      </p>

      {/* Ref pickers */}
      <div className="flex items-center gap-2 flex-wrap mb-5 rounded-md border border-fh-border bg-fh-surface px-3 py-2.5">
        <span className="text-fh-sm text-fh-fg-muted">base:</span>
        <div className="w-[180px]">
          <Select value={baseRef} onChange={(e) => setRefs(e.target.value, headRef)} sizing="sm">
            {!branchNames.includes(baseRef) && <option value={baseRef}>{baseRef}</option>}
            {branches.map((b) => <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>)}
          </Select>
        </div>
        <span className="text-fh-fg-subtle select-none px-1" aria-hidden="true">←</span>
        <span className="text-fh-sm text-fh-fg-muted">compare:</span>
        <div className="w-[180px]">
          <Select value={headRef} onChange={(e) => setRefs(baseRef, e.target.value)} sizing="sm">
            {!branchNames.includes(headRef) && headRef && <option value={headRef}>{headRef}</option>}
            {!headRef && <option value="">Select a branch…</option>}
            {branches.map((b) => <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>)}
          </Select>
        </div>

        <div className="flex-1" />

        {user && (
          <Button
            variant="primary"
            size="sm"
            loading={creating}
            disabled={!canOpenPr}
            title={canOpenPr ? "Open a pull request from this comparison" : "Pick two different branches with changes to open a PR"}
            onClick={openPullRequest}
          >
            Create pull request
          </Button>
        )}
      </div>

      {/* Summary + body */}
      {!bothChosen ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<CompareGlyph />} title="Choose a branch to compare" description="Select a base and a compare branch above." />
        </div>
      ) : sameRef ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<CompareGlyph />} title="Choose two different branches" description="The base and compare refs are the same." />
        </div>
      ) : loading && !result ? (
        <div className="space-y-4">
          <Skeleton className="h-5 w-64" />
          <div className="rounded-md border border-fh-border bg-fh-surface h-24" />
        </div>
      ) : error ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<CompareGlyph />} title="Comparison failed" description={error} />
        </div>
      ) : result ? (
        <div className="space-y-5">
          {/* ahead/behind summary */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fh-sm">
            {result.identical || (result.ahead === 0 && result.behind === 0) ? (
              <span className="text-fh-fg-muted">These branches are identical — nothing to compare.</span>
            ) : (
              <>
                <span className="font-semibold text-fh-fg">
                  {result.commits.length} commit{result.commits.length !== 1 ? "s" : ""}
                </span>
                <span className="text-fh-fg-muted">
                  <span className="font-mono text-fh-fg">{headRef}</span> is {result.ahead} ahead
                  {result.behind > 0 && <>, {result.behind} behind</>} <span className="font-mono text-fh-fg">{baseRef}</span>
                </span>
                {diffs && diffs.length > 0 && (
                  <>
                    <span className="text-fh-border-strong" aria-hidden="true">·</span>
                    <DiffCounts additions={totalAdd} deletions={totalDel} />
                    <DiffStatBar additions={totalAdd} deletions={totalDel} />
                  </>
                )}
              </>
            )}
          </div>

          {/* commit list */}
          {result.commits.length > 0 && <CommitList commits={result.commits} base={base} />}

          {/* file diffs */}
          {diffs === null && result.commits.length > 0 ? (
            <div className="space-y-4">
              {[0, 1].map((i) => (
                <div key={i} className="rounded-md border border-fh-border bg-fh-surface">
                  <div className="h-10 rounded-t-md border-b border-fh-border bg-fh-surface-muted" />
                  <div className="space-y-2 p-4">{[0, 1, 2].map((j) => <Skeleton key={j} variant="text" />)}</div>
                </div>
              ))}
            </div>
          ) : diffs && diffs.length > 0 ? (
            <div className="space-y-4">
              {diffs.map((file, i) => (
                <FileDiffCard key={i} file={file} sha={headRef} base={base} token={token} index={i} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
