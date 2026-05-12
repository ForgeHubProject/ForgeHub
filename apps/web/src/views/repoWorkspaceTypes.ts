import type { Dispatch, SetStateAction } from "react";
import type { DiffResult, Entity, Snapshot, SnapshotSummary } from "../types";

export type RepoModule = {
  sourceFile: string;
  displayName: string;
  commits: SnapshotSummary[];
};

export type RepoCodeWorkspaceProps = {
  /** Handler for the active snapshot (or best guess); used by Fallback and resolver. */
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
  visibleCommits: SnapshotSummary[];
  handleModuleClick: (sourceFile: string) => void;
  loadCommit: (commitId: string, moduleCommits: SnapshotSummary[]) => Promise<void>;
};
