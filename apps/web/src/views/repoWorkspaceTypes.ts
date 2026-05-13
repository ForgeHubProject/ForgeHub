import type { Dispatch, SetStateAction } from "react";
import type { DiffResult, Snapshot, SnapshotSummary } from "../types";
import type { GitCommitGroup } from "../lib/commitGroups";

export type RepoModule = {
  sourceFile: string;
  displayName: string;
  commits: SnapshotSummary[];
};

export type CommitFilePreviewRow = {
  snapshotId: string;
  sourceFile: string;
  handlerId: string;
  loading: boolean;
  stats: { added: number; removed: number; modified: number; moved: number } | null;
  error?: string;
};

export type RepoCodeWorkspaceProps = {
  workspaceHandlerId: string | undefined;
  loadingSnap: boolean;
  diffLoading: boolean;
  modules: RepoModule[];
  selectedModuleFile: string | null;
  setSelectedModuleFile: Dispatch<SetStateAction<string | null>>;
  activeSnapshot: Snapshot | null;
  activeCommitId: string | null;
  selectionPath: string[];
  setSelectionPath: Dispatch<SetStateAction<string[]>>;
  diffResult: DiffResult | null;
  diffMode: boolean;
  setDiffMode: Dispatch<SetStateAction<boolean>>;
  ghostSelectedId: string | null;
  setGhostSelectedId: Dispatch<SetStateAction<string | null>>;
  commitGroups: GitCommitGroup[];
  expandedCommitKey: string | null;
  commitFilePreviews: CommitFilePreviewRow[] | null;
  /** Filled when a multi-file commit has been expanded at least once this session (paths with a delta vs predecessor). */
  commitChangedFileCountByKey?: Record<string, number>;
  /** True while background/expand counting is in progress for a commit group. */
  commitChangedFileCountLoadingByKey?: Record<string, boolean>;
  onCommitGroupToggle: (group: GitCommitGroup) => void;
  onPickSnapshotFromCommit: (snap: SnapshotSummary) => void;
  handleModuleClick: (sourceFile: string) => void;
  loadCommit: (commitId: string, moduleCommits: SnapshotSummary[]) => Promise<void>;
};
