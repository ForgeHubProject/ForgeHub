import type { CommitFilePreviewRow } from "../views/repoWorkspaceTypes";
import type { DiffResult, SnapshotSummary } from "../types";

export type ChangeCounts = {
  added: number;
  removed: number;
  modified: number;
  moved: number;
};

export type GitCommitGroup = {
  key: string;
  gitCommitSha: string | null;
  label: string | null;
  createdAt: string;
  snapshots: SnapshotSummary[];
};

function snapshotSortKey(s: SnapshotSummary): number {
  const t = new Date(s.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function compareSnapshotsChronological(a: SnapshotSummary, b: SnapshotSummary): number {
  const dt = snapshotSortKey(a) - snapshotSortKey(b);
  return dt !== 0 ? dt : a.id.localeCompare(b.id);
}

/** Group ingested snapshots by Git commit SHA (multi-file pushes share one group). */
export function buildGitCommitGroups(snapshots: SnapshotSummary[]): GitCommitGroup[] {
  const byKey = new Map<string, SnapshotSummary[]>();

  for (const s of snapshots) {
    const key = s.gitCommitSha ?? `local:${s.id}`;
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }

  const groups: GitCommitGroup[] = [];
  for (const [key, rows] of byKey) {
    const sorted = [...rows].sort(compareSnapshotsChronological);
    const newest = sorted[sorted.length - 1]!;
    const sha = sorted[0]?.gitCommitSha ?? null;
    const label = sorted.find((r) => r.label)?.label ?? null;
    groups.push({
      key,
      gitCommitSha: sha,
      label,
      createdAt: newest.createdAt,
      snapshots: sorted,
    });
  }

  return groups.sort((a, b) => {
    const dt = snapshotSortKey(b) - snapshotSortKey(a);
    return dt !== 0 ? dt : b.key.localeCompare(a.key);
  });
}

/** Prior snapshot id for the same source file in chronological order, or null if first. */
export function predecessorSnapshotId(
  snapshot: SnapshotSummary,
  all: SnapshotSummary[],
): string | null {
  const chain = all
    .filter((s) => s.sourceFile === snapshot.sourceFile)
    .sort(compareSnapshotsChronological);
  const idx = chain.findIndex((s) => s.id === snapshot.id);
  if (idx <= 0) return null;
  return chain[idx - 1]!.id;
}

export function diffResultToChangeCounts(diff: DiffResult): ChangeCounts {
  if ("lines" in diff) {
    return {
      added: diff.summary.added,
      removed: diff.summary.removed,
      modified: 0,
      moved: 0,
    };
  }
  return {
    added: diff.summary.added,
    removed: diff.summary.removed,
    modified: diff.summary.modified,
    moved: diff.summary.moved,
  };
}

export function isChangeCountsEmpty(stats: ChangeCounts): boolean {
  return stats.added === 0 && stats.removed === 0 && stats.modified === 0 && stats.moved === 0;
}

export function commitGroupFileChipLabel(opts: {
  pathsInCommit: number;
  commitKey: string;
  isExpanded: boolean;
  previews: CommitFilePreviewRow[] | null;
  knownChangedFileCountByKey?: Record<string, number>;
  knownChangedFileCountLoadingByKey?: Record<string, boolean>;
}): string {
  const n = opts.pathsInCommit;
  const fileWord = n === 1 ? "file" : "files";

  if (opts.knownChangedFileCountLoadingByKey?.[opts.commitKey]) {
    return `${n} ${fileWord}`;
  }

  const known = opts.knownChangedFileCountByKey?.[opts.commitKey];
  if (known !== undefined) {
    if (known === 0) return `0 ${fileWord} changed`;
    if (known === n) return `${known} ${fileWord} changed`;
    return `${known} of ${n} ${fileWord} changed`;
  }

  if (opts.isExpanded && opts.previews) {
    const changed = opts.previews.length;
    if (changed === 0) return `0 ${fileWord} changed`;
    if (changed === n) return `${changed} ${fileWord} changed`;
    return `${changed} of ${n} ${fileWord} changed`;
  }

  return `${n} ${fileWord}`;
}
