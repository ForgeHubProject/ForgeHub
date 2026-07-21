import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { deleteBranch, listBranches } from "../../api";
import type { BranchInfo, User } from "../../types";
import { Badge, ConfirmDialog, EmptyState, RelativeTime, Skeleton, cx, useToast } from "../../ui";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  base: string;
};

function BranchGlyph({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
    </svg>
  );
}

function TrashGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z" />
    </svg>
  );
}

/** Split ahead/behind bar vs the default branch: ahead (accent) | behind (danger). */
function AheadBehindBar({ ahead, behind }: { ahead: number; behind: number }) {
  const total = ahead + behind;
  if (total === 0) {
    return <span className="text-fh-xs text-fh-fg-subtle whitespace-nowrap">Up to date</span>;
  }
  const aheadPct = (ahead / total) * 100;
  return (
    <div className="flex items-center gap-2 text-fh-xs" title={`${ahead} ahead, ${behind} behind the default branch`}>
      <span className="tabular-nums text-fh-fg-muted w-6 text-right">{ahead}</span>
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-fh-neutral-muted" aria-hidden="true">
        <div className="bg-fh-accent-emphasis" style={{ width: `${aheadPct}%` }} />
        <div className="bg-fh-danger-fg" style={{ width: `${100 - aheadPct}%` }} />
      </div>
      <span className="tabular-nums text-fh-fg-muted w-6">{behind}</span>
    </div>
  );
}

function BranchRow({
  branch, base, defaultBranch, canDelete, onDelete,
}: {
  branch: BranchInfo;
  base: string;
  defaultBranch: string;
  canDelete: boolean;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-fh-border-muted last:border-b-0 hover:bg-fh-surface-muted/50">
      <BranchGlyph className="text-fh-fg-subtle shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`${base}/tree/${branch.name}`}
            className="font-semibold text-fh-base text-fh-fg no-underline hover:text-fh-accent-fg hover:underline truncate"
          >
            {branch.name}
          </Link>
          {branch.isDefault && <Badge tone="accent" pill={false} className="text-fh-xs">default</Badge>}
          {branch.protected && <Badge tone="neutral" pill={false} className="text-fh-xs">protected</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-fh-xs text-fh-fg-subtle min-w-0">
          <span className="font-mono">{branch.sha}</span>
          {branch.date && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">Updated <RelativeTime date={branch.date} /></span>
            </>
          )}
        </div>
      </div>

      {!branch.isDefault && (
        <div className="hidden sm:block shrink-0">
          <AheadBehindBar ahead={branch.ahead ?? 0} behind={branch.behind ?? 0} />
        </div>
      )}

      {!branch.isDefault && (
        <Link
          to={`${base}/compare/${encodeURIComponent(defaultBranch)}...${branch.name}`}
          className="shrink-0 text-fh-xs text-fh-accent-fg no-underline hover:underline whitespace-nowrap"
        >
          Compare
        </Link>
      )}

      {canDelete && !branch.isDefault && !branch.protected && (
        <button
          type="button"
          onClick={() => onDelete(branch.name)}
          aria-label={`Delete branch ${branch.name}`}
          title={`Delete ${branch.name}`}
          className={cx(
            "shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md border border-fh-border",
            "text-fh-fg-muted hover:text-fh-danger-fg hover:border-fh-danger-fg/40 hover:bg-fh-danger-muted transition-colors cursor-pointer",
          )}
        >
          <TrashGlyph />
        </button>
      )}
    </div>
  );
}

export function RepoBranchesTab({ token, handle, repoName, user, base }: Props) {
  const { toast } = useToast();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canDelete = user.handle === handle;

  function load() {
    setLoading(true);
    setError(null);
    listBranches(token, handle, repoName)
      .then((d) => { setBranches(d.branches); setDefaultBranch(d.defaultBranch); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load branches"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [token, handle, repoName]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteBranch(token, handle, repoName, pendingDelete);
      toast(`Branch ${pendingDelete} deleted`, { tone: "success" });
      setBranches((bs) => bs.filter((b) => b.name !== pendingDelete));
      setPendingDelete(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not delete branch", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  const def = branches.find((b) => b.isDefault);
  const others = branches.filter((b) => !b.isDefault);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <BranchGlyph className="text-fh-fg-subtle" />
        <h2 className="text-fh-lg font-semibold text-fh-fg">Branches</h2>
      </div>

      {loading ? (
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-fh-border-muted last:border-b-0">
              <Skeleton variant="circle" className="w-4 h-4" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5" width={140 + i * 20} />
                <Skeleton className="h-3 w-40" />
              </div>
              <Skeleton className="h-2 w-24" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<BranchGlyph />} title="Couldn't load branches" description={error} />
        </div>
      ) : branches.length === 0 ? (
        <div className="border border-fh-border rounded-md bg-fh-surface">
          <EmptyState icon={<BranchGlyph />} title="No branches yet" description="Push your first commit to create the default branch." />
        </div>
      ) : (
        <>
          {def && (
            <>
              <p className="text-fh-sm font-semibold text-fh-fg-muted mb-2">Default branch</p>
              <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface mb-6">
                <BranchRow branch={def} base={base} defaultBranch={defaultBranch} canDelete={canDelete} onDelete={setPendingDelete} />
              </div>
            </>
          )}
          <p className="text-fh-sm font-semibold text-fh-fg-muted mb-2">
            {others.length > 0 ? "Active branches" : "No other branches"}
          </p>
          {others.length > 0 && (
            <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
              {others.map((b) => (
                <BranchRow key={b.name} branch={b} base={base} defaultBranch={defaultBranch} canDelete={canDelete} onDelete={setPendingDelete} />
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete branch?"
        message={`This permanently deletes the branch ${pendingDelete ?? ""}. This cannot be undone.`}
        confirmLabel="Delete branch"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
