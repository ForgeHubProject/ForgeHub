import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  API_BASE,
  closePull,
  compareDiff,
  createBranch,
  createPull,
  deleteBranch,
  forkRepo,
  getRepo,
  getSnapshot,
  getSnapshots,
  listBranches,
  listPulls,
  listTags,
  mergePull,
  resolveMergePr,
  type MergeFileResolution,
  type MergeSide,
} from "../api";
import type { BranchInfo, DiffResult, PullRequest, Repo, Snapshot, SnapshotSummary, TagInfo, User } from "../types";
import {
  buildGitCommitGroups,
  diffResultToChangeCounts,
  isChangeCountsEmpty,
  predecessorSnapshotId,
  type GitCommitGroup,
} from "../lib/commitGroups";
import { defaultHunkSides, groupPlainTextHunks } from "../lib/textMergeHunks";
import { GLTF_SCENE_HANDLER_ID, PLAIN_TEXT_HANDLER_ID } from "../views/constants";
import { isGlTfDiff, isPlainTextDiff } from "../types";
import type { CommitFilePreviewRow, RepoModule } from "../views/repoWorkspaceTypes";
import { resolveRepoCodeWorkspace } from "../views/registry";

type Props = {
  token: string;
  user: User;
};

/** Newest snapshot for a path within a branch-filtered snapshot list. */
function latestSnapshotForFile(list: SnapshotSummary[], sourceFile: string): SnapshotSummary | null {
  const rows = list.filter((s) => s.sourceFile === sourceFile);
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return ta > tb ? a : b;
    return a.id.localeCompare(b.id) >= 0 ? a : b;
  });
}

export function SnapshotPage({ token, user }: Props) {
  const { handle = "", repoName = "" } = useParams<{ handle: string; repoName: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [repo, setRepo]       = useState<Repo | null>(null);
  const [repoLoading, setRepoLoading] = useState(true);

  const [snapshots, setSnapshots]           = useState<SnapshotSummary[]>([]);
  const [selectedModuleFile, setSelectedModuleFile] = useState<string | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<Snapshot | null>(null);
  const [activeCommitId, setActiveCommitId] = useState<string | null>(null);
  const [selectionPath, setSelectionPath]   = useState<string[]>([]);
  const [loadingSnap, setLoadingSnap]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);

  const [diffResult, setDiffResult]   = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMode, setDiffMode]       = useState(true);
  const [ghostSelectedId, setGhostSelectedId] = useState<string | null>(null);

  const [expandedCommitKey, setExpandedCommitKey] = useState<string | null>(null);
  const [commitFilePreviews, setCommitFilePreviews] = useState<CommitFilePreviewRow[] | null>(null);
  const [commitChangedFileCountByKey, setCommitChangedFileCountByKey] = useState<Record<string, number>>({});
  const [commitChangedFileCountLoadingByKey, setCommitChangedFileCountLoadingByKey] = useState<Record<string, boolean>>(
    {},
  );
  const [changedCommitKeysForSelectedFile, setChangedCommitKeysForSelectedFile] = useState<Record<string, boolean>>({});
  const [changedCommitKeysForSelectedFileLoading, setChangedCommitKeysForSelectedFileLoading] = useState<Record<string, boolean>>(
    {},
  );
  const expandFetchGen = useRef(0);
  const changedCountGen = useRef(0);
  const selectedFileChangeGen = useRef(0);

  // Branch selector
  const [branches, setBranches]             = useState<BranchInfo[]>([]);
  const [tags, setTags]                     = useState<TagInfo[]>([]);
  const [defaultBranchName, setDefaultBranchName] = useState<string>("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(() => searchParams.get("branch"));
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branchFilter, setBranchFilter]     = useState("");
  const [newBranchName, setNewBranchName]   = useState("");
  /** Tip ref for `POST /branches` `from` — any existing branch, not only the one you're viewing. */
  const [branchCreateFrom, setBranchCreateFrom] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branchError, setBranchError]       = useState<string | null>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  // Tab: "code" | "pulls"
  const [activeTab, setActiveTab] = useState<"code" | "pulls">(() =>
    searchParams.get("tab") === "pulls" ? "pulls" : "code"
  );

  // Pull requests
  const [pulls, setPulls]                 = useState<PullRequest[]>([]);
  const [pullsLoading, setPullsLoading]   = useState(false);
  /** Open PR count for the nav badge; kept in sync even when the PR list filter is not "open". */
  const [openPullCount, setOpenPullCount] = useState(0);
  const [selectedPr, setSelectedPr]       = useState<PullRequest | null>(null);
  const [prActionLoading, setPrActionLoading] = useState(false);
  const [prError, setPrError]             = useState<string | null>(null);
  const [prConflict, setPrConflict]       = useState(false);
  const [mergeReviewPr, setMergeReviewPr] = useState<PullRequest | null>(null);
  const [mergeReviewFromSnapshots, setMergeReviewFromSnapshots] = useState<SnapshotSummary[]>([]);
  const [mergeReviewFromLoading, setMergeReviewFromLoading] = useState(false);
  const [mergeTextHunkSidesByFile, setMergeTextHunkSidesByFile] = useState<Record<string, Record<string, MergeSide>>>({});
  const [mergeGltfEntitySidesByFile, setMergeGltfEntitySidesByFile] = useState<Record<string, Record<string, MergeSide>>>({});
  const [mergeGltfFieldSidesByFile, setMergeGltfFieldSidesByFile] = useState<Record<string, Record<string, MergeSide>>>({});
  const [showNewPr, setShowNewPr]         = useState(false);
  const [newPrTitle, setNewPrTitle]       = useState("");
  const [newPrFrom, setNewPrFrom]         = useState("");
  /** Base branch (GitHub "into" / compare base). */
  const [newPrTo, setNewPrTo]             = useState("");
  const [newPrDesc, setNewPrDesc]         = useState("");
  const [pullsFilter, setPullsFilter]     = useState<"open" | "merged" | "closed" | "all">("open");

  const [forking, setForking]     = useState(false);
  const [forkMsg, setForkMsg]     = useState<string | null>(null);

  const cloneUrl  = `${API_BASE}/git/${handle}/${repoName}.git`;
  const isOwner   = handle === user.handle;

  // Load repo metadata from API
  useEffect(() => {
    if (!handle || !repoName) return;
    setRepoLoading(true);
    getRepo(token, handle, repoName)
      .then(setRepo)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load repo"))
      .finally(() => setRepoLoading(false));
  }, [token, handle, repoName]);

  // Group snapshots by sourceFile → Modules
  const modules = useMemo<RepoModule[]>(() => {
    const map = new Map<string, SnapshotSummary[]>();
    for (const s of snapshots) {
      if (!map.has(s.sourceFile)) map.set(s.sourceFile, []);
      map.get(s.sourceFile)!.push(s);
    }
    return Array.from(map.entries()).map(([sourceFile, commits]) => ({
      sourceFile,
      displayName: sourceFile.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
      commits: [...commits].sort((a, b) => {
        const dt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return dt !== 0 ? dt : a.id.localeCompare(b.id);
      }),
    }));
  }, [snapshots]);

  const commitGroups = useMemo(() => buildGitCommitGroups(snapshots), [snapshots]);

  /** Sidebar: when a module is selected, list only commits that touch that file (same idea as GitHub file history). */
  const workspaceCommitGroups = useMemo(() => {
    if (!selectedModuleFile) return commitGroups;
    return commitGroups.filter((g) => g.snapshots.some((s) => s.sourceFile === selectedModuleFile));
  }, [commitGroups, selectedModuleFile]);

  const snapshotListIdentity = useMemo(
    () => snapshots.map((s) => `${s.id}:${s.gitCommitSha ?? ""}`).join("|"),
    [snapshots],
  );
  useEffect(() => {
    setCommitChangedFileCountByKey({});
    setCommitChangedFileCountLoadingByKey({});
    setChangedCommitKeysForSelectedFile({});
    setChangedCommitKeysForSelectedFileLoading({});
  }, [snapshotListIdentity]);

  // When a file is selected, compute which commits actually changed that file (vs its predecessor snapshot).
  useEffect(() => {
    if (!handle || !repoName) return;
    if (!selectedModuleFile) {
      setChangedCommitKeysForSelectedFile({});
      setChangedCommitKeysForSelectedFileLoading({});
      return;
    }

    const gen = ++selectedFileChangeGen.current;
    const file = selectedModuleFile;
    const chain = snapshots
      .filter((s) => s.sourceFile === file)
      .sort((a, b) => {
        const dt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return dt !== 0 ? dt : a.id.localeCompare(b.id);
      });

    if (chain.length === 0) {
      setChangedCommitKeysForSelectedFile({});
      setChangedCommitKeysForSelectedFileLoading({});
      return;
    }

    let cancelled = false;
    const nextLoading: Record<string, boolean> = {};
    for (const s of chain) {
      const key = s.gitCommitSha ?? `local:${s.id}`;
      nextLoading[key] = true;
    }
    setChangedCommitKeysForSelectedFile({});
    setChangedCommitKeysForSelectedFileLoading(nextLoading);

    async function compute(): Promise<void> {
      const out: Record<string, boolean> = {};
      for (let i = 0; i < chain.length; i++) {
        const cur = chain[i]!;
        const key = cur.gitCommitSha ?? `local:${cur.id}`;
        const pred = i > 0 ? chain[i - 1]! : null;
        if (!pred) {
          out[key] = true; // first version counts as a change
          continue;
        }
        try {
          const diff = await compareDiff(token, handle, repoName, pred.id, cur.id);
          const stats = diffResultToChangeCounts(diff);
          out[key] = !isChangeCountsEmpty(stats);
        } catch {
          out[key] = true; // treat errors as "changed" so it stays visible
        }
      }
      if (cancelled || selectedFileChangeGen.current !== gen) return;
      setChangedCommitKeysForSelectedFile(out);
      const doneLoading: Record<string, boolean> = {};
      for (const k of Object.keys(nextLoading)) doneLoading[k] = false;
      setChangedCommitKeysForSelectedFileLoading(doneLoading);
    }

    void compute();
    return () => {
      cancelled = true;
    };
  }, [token, handle, repoName, snapshots, selectedModuleFile]);

  // Pre-compute "files changed" counts for multi-file commits so the chip is meaningful without clicking.
  useEffect(() => {
    if (!handle || !repoName) return;
    if (snapshots.length === 0) return;

    const gen = ++changedCountGen.current;
    const groupsToCompute = commitGroups.filter((g) => g.snapshots.length > 1 && commitChangedFileCountByKey[g.key] === undefined);
    if (groupsToCompute.length === 0) return;

    let cancelled = false;

    async function computeForGroup(group: GitCommitGroup): Promise<void> {
      setCommitChangedFileCountLoadingByKey((prev) => ({ ...prev, [group.key]: true }));

      let changed = 0;
      for (const s of group.snapshots) {
        const pred = predecessorSnapshotId(s, snapshots);
        if (!pred) {
          changed += 1; // first version counts as a change
          continue;
        }
        try {
          const diff = await compareDiff(token, handle, repoName, pred, s.id);
          const stats = diffResultToChangeCounts(diff);
          if (!isChangeCountsEmpty(stats)) changed += 1;
        } catch {
          // If compare fails, treat as changed so the commit remains "interesting" rather than looking empty.
          changed += 1;
        }
      }

      if (cancelled || changedCountGen.current !== gen) return;
      setCommitChangedFileCountByKey((prev) => ({ ...prev, [group.key]: changed }));
      setCommitChangedFileCountLoadingByKey((prev) => ({ ...prev, [group.key]: false }));
    }

    // Simple concurrency cap to avoid spamming the API.
    const CONCURRENCY = 4;
    const queue = [...groupsToCompute];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (!cancelled && queue.length > 0) {
        const g = queue.shift();
        if (!g) return;
        await computeForGroup(g);
      }
    });

    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [
    token,
    handle,
    repoName,
    snapshots,
    commitGroups,
    commitChangedFileCountByKey,
  ]);

  async function refreshSnapshots(branch?: string) {
    setLoadingSnap(true);
    setError(null);
    try {
      const r = await getSnapshots(token, handle, repoName, branch ?? selectedBranch ?? undefined);
      setSnapshots(r.snapshots);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setLoadingSnap(false);
    }
  }

  async function loadBranches() {
    try {
      const [br, tg] = await Promise.all([
        listBranches(token, handle, repoName),
        listTags(token, handle, repoName),
      ]);
      setBranches(br.branches);
      setDefaultBranchName(br.defaultBranch);
      setTags(tg.tags);
    } catch (e) {
      setError(`Branch load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleCreateBranch() {
    if (!newBranchName.trim()) return;
    setCreatingBranch(true);
    setBranchError(null);
    try {
      const fromRef =
        (branchCreateFrom && branches.some((b) => b.name === branchCreateFrom) ? branchCreateFrom : null)
        ?? selectedBranch
        ?? defaultBranchName
        ?? "HEAD";
      await createBranch(token, handle, repoName, newBranchName.trim(), fromRef);
      setNewBranchName("");
      await loadBranches();
      handleBranchChange(newBranchName.trim());
      setShowBranchMenu(false);
    } catch (e) {
      setBranchError(e instanceof Error ? e.message : "Failed to create branch");
    } finally {
      setCreatingBranch(false);
    }
  }

  async function handleDeleteBranch(branch: string) {
    if (!confirm(`Delete branch "${branch}"?`)) return;
    try {
      await deleteBranch(token, handle, repoName, branch);
      if (selectedBranch === branch) setSelectedBranch(null);
      await loadBranches();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete branch");
    }
  }

  // Close branch menu on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const refreshOpenPullCount = useCallback(async () => {
    if (!handle || !repoName) return;
    try {
      const r = await listPulls(token, handle, repoName, "open");
      setOpenPullCount(r.pulls.length);
    } catch {
      setOpenPullCount(0);
    }
  }, [token, handle, repoName]);

  const loadPulls = useCallback(
    async (filter: typeof pullsFilter = pullsFilter) => {
      if (!handle || !repoName) return;
      setPullsLoading(true);
      setPrError(null);
      try {
        const r = await listPulls(token, handle, repoName, filter);
        setPulls(r.pulls);
        if (filter === "open") setOpenPullCount(r.pulls.length);
      } catch (e) {
        setPrError(e instanceof Error ? e.message : "Failed to load PRs");
      } finally {
        setPullsLoading(false);
      }
    },
    [token, handle, repoName, pullsFilter],
  );

  useEffect(() => {
    void loadPulls();
  }, [loadPulls]);

  async function handleMergePr(pr: PullRequest) {
    setPrActionLoading(true);
    setPrError(null);
    setPrConflict(false);
    try {
      await mergePull(token, handle, repoName, pr.number);
      setSelectedPr({ ...pr, state: "merged" });
      setMergeReviewPr(null);
      setMergeReviewFromSnapshots([]);
      await loadPulls();
      if (pullsFilter !== "open") await refreshOpenPullCount();
      await refreshSnapshots();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Merge failed";
      setPrError(msg);
      if (msg.includes("cannot auto-merge")) setPrConflict(true);
    } finally {
      setPrActionLoading(false);
    }
  }

  async function handleResolveConflict(pr: PullRequest, strategy: "ours" | "theirs") {
    setPrActionLoading(true);
    setPrError(null);
    setPrConflict(false);
    try {
      await resolveMergePr(token, handle, repoName, pr.number, { strategy });
      setSelectedPr({ ...pr, state: "merged" });
      setMergeReviewPr(null);
      setMergeReviewFromSnapshots([]);
      await loadPulls();
      if (pullsFilter !== "open") await refreshOpenPullCount();
      await refreshSnapshots();
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Resolution failed");
    } finally {
      setPrActionLoading(false);
    }
  }

  function handleClearMergeReview() {
    setMergeReviewPr(null);
    setMergeReviewFromSnapshots([]);
    setMergeReviewFromLoading(false);
    setMergeTextHunkSidesByFile({});
    setMergeGltfEntitySidesByFile({});
    setMergeGltfFieldSidesByFile({});
    setDiffResult(null);
  }

  const currentTextHunkSides = selectedModuleFile ? mergeTextHunkSidesByFile[selectedModuleFile] : undefined;
  const currentGltfEntitySides = selectedModuleFile ? mergeGltfEntitySidesByFile[selectedModuleFile] : undefined;
  const currentGltfFieldSides = selectedModuleFile ? mergeGltfFieldSidesByFile[selectedModuleFile] : undefined;

  useEffect(() => {
    if (!mergeReviewPr || !selectedModuleFile || !diffResult) return;
    if (isPlainTextDiff(diffResult)) {
      const hunks = groupPlainTextHunks(diffResult.lines);
      if (hunks.length === 0) return;
      setMergeTextHunkSidesByFile((prev) => {
        if (prev[selectedModuleFile]) return prev;
        return { ...prev, [selectedModuleFile]: defaultHunkSides(hunks, "incoming") };
      });
    }
    if (isGlTfDiff(diffResult)) {
      const changed = diffResult.changes.filter((c) => c.type !== "unchanged");
      if (changed.length === 0) return;
      setMergeGltfEntitySidesByFile((prev) => {
        if (prev[selectedModuleFile]) return prev;
        const m: Record<string, MergeSide> = {};
        for (const c of changed) {
          m[c.entityId] = c.type === "removed" ? "base" : "incoming";
        }
        return { ...prev, [selectedModuleFile]: m };
      });
    }
  }, [mergeReviewPr, selectedModuleFile, diffResult]);

  function setTextHunkSide(hunkId: string, side: MergeSide) {
    if (!selectedModuleFile) return;
    setMergeTextHunkSidesByFile((prev) => ({
      ...prev,
      [selectedModuleFile]: { ...(prev[selectedModuleFile] ?? {}), [hunkId]: side },
    }));
  }

  function setGltfEntitySide(entityId: string, side: MergeSide) {
    if (!selectedModuleFile) return;
    setMergeGltfEntitySidesByFile((prev) => ({
      ...prev,
      [selectedModuleFile]: { ...(prev[selectedModuleFile] ?? {}), [entityId]: side },
    }));
  }

  function setGltfFieldSide(entityId: string, field: string, side: MergeSide) {
    if (!selectedModuleFile) return;
    const key = `${entityId}:${field}`;
    setMergeGltfFieldSidesByFile((prev) => ({
      ...prev,
      [selectedModuleFile]: { ...(prev[selectedModuleFile] ?? {}), [key]: side },
    }));
  }

  async function buildGranularMergeFiles(pr: PullRequest): Promise<MergeFileResolution[]> {
    const paths = new Set<string>();
    for (const s of snapshots) paths.add(s.sourceFile);
    for (const s of mergeReviewFromSnapshots) paths.add(s.sourceFile);
    const files: MergeFileResolution[] = [];

    for (const sourceFile of paths) {
      const toSnap = latestSnapshotForFile(snapshots, sourceFile);
      const fromSnap = latestSnapshotForFile(mergeReviewFromSnapshots, sourceFile);
      if (!toSnap || !fromSnap || toSnap.handlerId !== fromSnap.handlerId) continue;

      const diff = await compareDiff(token, handle, repoName, toSnap.id, fromSnap.id);

      if (isPlainTextDiff(diff)) {
        const hunks = groupPlainTextHunks(diff.lines);
        if (hunks.length === 0) continue;
        const sides = mergeTextHunkSidesByFile[sourceFile] ?? defaultHunkSides(hunks, "incoming");
        files.push({
          sourceFile,
          hunks: hunks.map((h) => ({ hunkId: h.id, side: sides[h.id] ?? "incoming" })),
        });
      } else if (isGlTfDiff(diff)) {
        const changed = diff.changes.filter((c) => c.type !== "unchanged");
        if (changed.length === 0) continue;
        const entitySides = mergeGltfEntitySidesByFile[sourceFile] ?? {};
        const fieldSides = mergeGltfFieldSidesByFile[sourceFile] ?? {};
        const entities = changed.map((c) => ({
          entityId: c.entityId,
          side: entitySides[c.entityId] ?? (c.type === "removed" ? "base" : "incoming"),
        }));
        const fields: Array<{ entityId: string; field: string; side: MergeSide }> = [];
        for (const c of changed) {
          for (const fc of c.fieldChanges) {
            const key = `${c.entityId}:${fc.field}`;
            if (fieldSides[key]) {
              fields.push({ entityId: c.entityId, field: fc.field, side: fieldSides[key]! });
            }
          }
        }
        files.push({ sourceFile, entities, fields: fields.length > 0 ? fields : undefined });
      }
    }
    return files;
  }

  async function handleCompleteGranularMerge(pr: PullRequest) {
    setPrActionLoading(true);
    setPrError(null);
    try {
      const files = await buildGranularMergeFiles(pr);
      if (files.length === 0) {
        setPrError("No merge changes to apply");
        return;
      }
      await resolveMergePr(token, handle, repoName, pr.number, { files });
      setSelectedPr({ ...pr, state: "merged" });
      handleClearMergeReview();
      setPrConflict(false);
      await loadPulls();
      if (pullsFilter !== "open") await refreshOpenPullCount();
      await refreshSnapshots();
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Granular merge failed");
    } finally {
      setPrActionLoading(false);
    }
  }

  async function handleOpenMergeResolveEditor(pr: PullRequest) {
    setPrError(null);
    setMergeReviewFromLoading(true);
    try {
      const fromR = await getSnapshots(token, handle, repoName, pr.fromBranch);
      setMergeReviewFromSnapshots(fromR.snapshots);
      setMergeReviewPr(pr);
      setPrConflict(false);
      setDiffMode(true);
      setActiveTab("code");
      setSearchParams((prev) => {
        prev.delete("tab");
        return prev;
      }, { replace: true });
      handleBranchChange(pr.toBranch);
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Failed to load incoming branch");
      setMergeReviewFromSnapshots([]);
      setMergeReviewPr(null);
    } finally {
      setMergeReviewFromLoading(false);
    }
  }

  useEffect(() => {
    if (!mergeReviewPr || activeTab !== "code" || !selectedModuleFile || !handle || !repoName) return;
    if (selectedBranch !== mergeReviewPr.toBranch) return;
    if (loadingSnap) return;
    const fromSnap = latestSnapshotForFile(mergeReviewFromSnapshots, selectedModuleFile);
    const toSnap = latestSnapshotForFile(snapshots, selectedModuleFile);
    if (!fromSnap || !toSnap) {
      setDiffResult(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffResult(null);
    void (async () => {
      try {
        const snap = await getSnapshot(token, handle, repoName, toSnap.id);
        if (cancelled) return;
        setActiveSnapshot(snap);
        setActiveCommitId(toSnap.id);
        const diff = await compareDiff(token, handle, repoName, toSnap.id, fromSnap.id);
        if (!cancelled) setDiffResult(diff);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Merge review diff failed");
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    mergeReviewPr,
    activeTab,
    selectedModuleFile,
    snapshots,
    mergeReviewFromSnapshots,
    token,
    handle,
    repoName,
    selectedBranch,
    loadingSnap,
  ]);

  async function handleClosePr(pr: PullRequest) {
    setPrActionLoading(true);
    setPrError(null);
    try {
      await closePull(token, handle, repoName, pr.number);
      setSelectedPr({ ...pr, state: "closed" });
      await loadPulls();
      if (pullsFilter !== "open") await refreshOpenPullCount();
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Failed to close PR");
    } finally {
      setPrActionLoading(false);
    }
  }

  async function handleFork() {
    setForking(true);
    setForkMsg(null);
    try {
      const forked = await forkRepo(token, handle, repoName);
      setForkMsg(`Forked as ${forked.name}`);
    } catch (e) {
      setForkMsg(e instanceof Error ? e.message : "Fork failed");
    } finally {
      setForking(false);
    }
  }

  async function handleCreatePr() {
    if (!newPrTitle.trim() || !newPrFrom || !newPrTo || newPrFrom === newPrTo) return;
    setPrActionLoading(true);
    setPrError(null);
    try {
      const pr = await createPull(token, handle, repoName, newPrTitle.trim(), newPrFrom, newPrTo, newPrDesc || undefined);
      setShowNewPr(false);
      setNewPrTitle(""); setNewPrFrom(""); setNewPrTo(""); setNewPrDesc("");
      await loadPulls();
      if (pullsFilter !== "open") await refreshOpenPullCount();
      setSelectedPr(pr);
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Failed to create PR");
    } finally {
      setPrActionLoading(false);
    }
  }

  useEffect(() => {
    if (branches.length === 0) return;
    setBranchCreateFrom((p) => {
      if (p && branches.some((b) => b.name === p)) return p;
      return selectedBranch ?? defaultBranchName ?? branches[0]!.name;
    });
  }, [branches, selectedBranch, defaultBranchName]);

  useEffect(() => {
    if (!showNewPr || branches.length === 0) return;
    setNewPrTo((t) => {
      if (t && branches.some((b) => b.name === t)) return t;
      if (defaultBranchName && branches.some((b) => b.name === defaultBranchName)) return defaultBranchName;
      return branches[0]!.name;
    });
  }, [showNewPr, branches, defaultBranchName]);

  useEffect(() => {
    if (!showNewPr || branches.length === 0 || !newPrTo) return;
    setNewPrFrom((f) => {
      if (f && f !== newPrTo && branches.some((b) => b.name === f)) return f;
      const alt = branches.find((b) => b.name !== newPrTo);
      return alt?.name ?? "";
    });
  }, [showNewPr, branches, newPrTo]);

  // Auto-load latest snapshot + branches on mount
  useEffect(() => {
    loadBranches();
  }, [handle, repoName]);

  useEffect(() => {
    let cancelled = false;
    setLoadingSnap(true);
    setError(null);
    setExpandedCommitKey(null);
    setCommitFilePreviews(null);

    getSnapshots(token, handle, repoName, selectedBranch ?? undefined)
      .then(async (r) => {
        if (cancelled) return;
        setSnapshots(r.snapshots);
        const latest = r.snapshots[0];
        if (!latest) {
          setActiveSnapshot(null);
          setActiveCommitId(null);
          setSelectedModuleFile(null);
          return;
        }
        const snap = await getSnapshot(token, handle, repoName, latest.id);
        if (!cancelled) {
          setActiveSnapshot(snap);
          setActiveCommitId(latest.id);
          setSelectedModuleFile(latest.sourceFile);
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed"); })
      .finally(() => { if (!cancelled) setLoadingSnap(false); });

    return () => { cancelled = true; };
  }, [token, handle, repoName, selectedBranch]);

  async function loadCommit(commitId: string, moduleCommits: SnapshotSummary[]) {
    setMergeReviewPr(null);
    setMergeReviewFromSnapshots([]);
    setLoadingSnap(true);
    setError(null);
    setDiffResult(null);

    // moduleCommits is sorted oldest→newest; find predecessor
    const sorted = [...moduleCommits].sort((a, b) => {
      const dt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });
    const idx = sorted.findIndex((c) => c.id === commitId);
    const predecessor = idx > 0 ? sorted[idx - 1] : null;

    try {
      const snap = await getSnapshot(token, handle, repoName, commitId);
      setActiveSnapshot(snap);
      setActiveCommitId(commitId);
      setSelectionPath([]);
      setGhostSelectedId(null);
      setDiffMode(true);

      if (predecessor) {
        setDiffLoading(true);
        try {
          const diff = await compareDiff(token, handle, repoName, predecessor.id, commitId);
          setDiffResult(diff);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Diff failed");
        } finally {
          setDiffLoading(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoadingSnap(false);
    }
  }

  function handleBranchChange(branch: string) {
    const b = branch === "__all__" ? null : branch;
    setSelectedBranch(b);
    setSearchParams((prev) => {
      if (b) prev.set("branch", b); else prev.delete("branch");
      return prev;
    }, { replace: true });
    setActiveSnapshot(null);
    setActiveCommitId(null);
    setDiffResult(null);
    setSelectionPath([]);
    setExpandedCommitKey(null);
    setCommitFilePreviews(null);
  }

  function handleModuleClick(sourceFile: string) {
    setSelectedModuleFile(sourceFile);
    setExpandedCommitKey(null);
    setCommitFilePreviews(null);
    const mod = modules.find((m) => m.sourceFile === sourceFile);
    if (mod && mod.commits.length > 0) {
      const latest = mod.commits[mod.commits.length - 1];
      loadCommit(latest.id, mod.commits);
    }
  }

  async function handleCommitGroupToggle(group: GitCommitGroup) {
    if (group.snapshots.length === 1) {
      setExpandedCommitKey(null);
      setCommitFilePreviews(null);
      const s = group.snapshots[0]!;
      const mod = modules.find((m) => m.sourceFile === s.sourceFile);
      await loadCommit(s.id, mod?.commits ?? [s]);
      return;
    }
    if (expandedCommitKey === group.key) {
      setExpandedCommitKey(null);
      setCommitFilePreviews(null);
      return;
    }
    const gen = ++expandFetchGen.current;
    setExpandedCommitKey(group.key);
    setCommitFilePreviews(
      group.snapshots.map((s) => ({
        snapshotId: s.id,
        sourceFile: s.sourceFile,
        handlerId: s.handlerId,
        loading: true,
        stats: null,
      })),
    );

    const results = await Promise.all(
      group.snapshots.map(async (s) => {
        const pred = predecessorSnapshotId(s, snapshots);
        if (!pred) {
          // No predecessor in our current snapshot chain → synthesize a diff against an "empty base"
          // so the UI still renders +/− badges.
          try {
            if (s.handlerId === GLTF_SCENE_HANDLER_ID) {
              const snap = await getSnapshot(token, handle, repoName, s.id);
              return {
                snapshotId: s.id,
                stats: {
                  added: snap.entities.length,
                  removed: 0,
                  modified: 0,
                  moved: 0,
                },
                error: undefined,
              };
            }
            if (s.handlerId === PLAIN_TEXT_HANDLER_ID) {
              const snap = await getSnapshot(token, handle, repoName, s.id);
              const body = snap.snapshotBody ?? "";
              const rawLines = body === "" ? [] : body.split(/\r?\n/);
              // Backend removes a trailing empty line if the file ends with a newline.
              if (body.endsWith("\n") || body.endsWith("\r\n")) {
                if (rawLines.length > 0) rawLines.pop();
              }
              return {
                snapshotId: s.id,
                stats: {
                  added: rawLines.length,
                  removed: 0,
                  modified: 0,
                  moved: 0,
                },
                error: undefined,
              };
            }
          } catch {
            // Fall through to generic "no predecessor" rendering.
          }
          return {
            snapshotId: s.id,
            stats: null as { added: number; removed: number; modified: number; moved: number } | null,
            error: undefined as string | undefined,
          };
        }
        try {
          const diff = await compareDiff(token, handle, repoName, pred, s.id);
          return { snapshotId: s.id, stats: diffResultToChangeCounts(diff), error: undefined };
        } catch (e) {
          return {
            snapshotId: s.id,
            stats: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    if (expandFetchGen.current !== gen) return;

    const rows: CommitFilePreviewRow[] = [];
    for (const s of group.snapshots) {
      const pred = predecessorSnapshotId(s, snapshots);
      const r = results.find((x) => x.snapshotId === s.id)!;
      const unchangedVsPred =
        Boolean(pred) &&
        !r.error &&
        r.stats != null &&
        isChangeCountsEmpty(r.stats);
      if (unchangedVsPred) continue;
      rows.push({
        snapshotId: s.id,
        sourceFile: s.sourceFile,
        handlerId: s.handlerId,
        loading: false,
        stats: r.stats,
        error: r.error,
      });
    }
    setCommitFilePreviews(rows);
    setCommitChangedFileCountByKey((prev) => ({ ...prev, [group.key]: rows.length }));
    setCommitChangedFileCountLoadingByKey((prev) => ({ ...prev, [group.key]: false }));
  }

  function onPickSnapshotFromCommit(snap: SnapshotSummary) {
    const mod = modules.find((m) => m.sourceFile === snap.sourceFile);
    void loadCommit(snap.id, mod?.commits ?? [snap]);
  }

  const workspaceHandlerId =
    activeSnapshot?.handlerId ??
    (activeCommitId ? snapshots.find((s) => s.id === activeCommitId)?.handlerId : undefined) ??
    snapshots[0]?.handlerId;

  const CodeWorkspace = resolveRepoCodeWorkspace(workspaceHandlerId);

  const activeBranchLabel = selectedBranch ?? defaultBranchName ?? "main";
  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(branchFilter.toLowerCase())
  );

  return (
    <div style={styles.shell}>
      {/* ── Row 1: repo identity + actions ── */}
      <header style={styles.topbar}>
        <button onClick={() => navigate("/")} style={styles.backBtn}>←</button>

        {/* Breadcrumb */}
        <div style={styles.breadcrumb}>
          <span style={styles.breadcrumbOwner}>{handle}</span>
          <span style={styles.breadcrumbSep}>/</span>
          <span style={styles.breadcrumbRepo}>{repoName}</span>
        </div>
        <span style={styles.visibilityBadge}>{repoLoading ? "…" : (repo?.visibility ?? "public")}</span>

        <div style={{ flex: 1 }} />

        {/* Action buttons (GitHub-style top-right) */}
        <div style={styles.actionBtns}>
          <button
            onClick={handleFork}
            disabled={forking || !isOwner === false}
            style={{ ...styles.actionBtn, ...(isOwner ? styles.actionBtnDisabled : {}) }}
            title={isOwner ? "Cannot fork your own repo" : "Fork this repository"}
          >
            ⑂ Fork
          </button>
          {forkMsg && <span style={{ fontSize: 11, color: "#22c55e" }}>{forkMsg}</span>}
        </div>
      </header>

      {/* ── Row 2: tabs + branch selector + clone ── */}
      <div style={styles.subnav}>
        {/* Tabs */}
        <div style={styles.navTabs}>
          <button
            style={{ ...styles.navTab, ...(activeTab === "code" ? styles.navTabActive : {}) }}
            onClick={() => {
              setActiveTab("code");
              setSearchParams((prev) => { prev.delete("tab"); return prev; }, { replace: true });
            }}
          >
            <span style={styles.navTabIcon}>{"<>"}</span> Code
          </button>
          <button
            style={{ ...styles.navTab, ...(activeTab === "pulls" ? styles.navTabActive : {}) }}
            onClick={() => {
              setActiveTab("pulls");
              setSearchParams((prev) => { prev.set("tab", "pulls"); return prev; }, { replace: true });
              loadPulls();
            }}
          >
            ⑂ Pull Requests
            {openPullCount > 0 && (
              <span style={styles.navTabBadge}>{openPullCount}</span>
            )}
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Branch dropdown + stats + clone */}
        {activeTab === "code" && (
          <div style={styles.codeToolbar}>
            {/* Branch popover */}
            <div style={{ position: "relative" }} ref={branchMenuRef}>
              <button
                style={styles.branchBtn}
                onClick={() => { setShowBranchMenu((v) => !v); setBranchFilter(""); setBranchError(null); }}
              >
                <span style={styles.branchBtnIcon}>⎇</span>
                <span style={{ fontWeight: 600 }}>{activeBranchLabel}</span>
                <span style={{ marginLeft: 4, opacity: 0.6 }}>▾</span>
              </button>

              {showBranchMenu && (
                <div style={styles.branchMenu}>
                  <div style={styles.branchMenuHeader}>Switch branches</div>

                  <div style={styles.branchMenuSearch}>
                    <input
                      autoFocus
                      placeholder="Filter branches…"
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      style={styles.branchMenuInput}
                    />
                  </div>

                  <div style={styles.branchMenuList}>
                    {/* "All branches" option */}
                    <button
                      style={{ ...styles.branchMenuItem, ...(selectedBranch === null ? styles.branchMenuItemActive : {}) }}
                      onClick={() => { handleBranchChange("__all__"); setShowBranchMenu(false); }}
                    >
                      <span style={styles.branchMenuCheck}>{selectedBranch === null ? "✓" : ""}</span>
                      <span>All branches</span>
                    </button>

                    {filteredBranches.length > 0 && (
                      <div style={styles.branchMenuGroupLabel}>Branches</div>
                    )}

                    {filteredBranches.map((b) => (
                      <div key={b.name} style={styles.branchMenuRow}>
                        <button
                          style={{ ...styles.branchMenuItem, ...(selectedBranch === b.name ? styles.branchMenuItemActive : {}) }}
                          onClick={() => { handleBranchChange(b.name); setShowBranchMenu(false); }}
                        >
                          <span style={styles.branchMenuCheck}>{selectedBranch === b.name ? "✓" : ""}</span>
                          <span style={{ flex: 1 }}>{b.name}</span>
                          {b.isDefault && <span style={styles.branchDefaultBadge}>default</span>}
                          {b.protected && <span style={{ fontSize: 10, opacity: 0.6 }}>🔒</span>}
                        </button>
                        {isOwner && !b.isDefault && !b.protected && (
                          <button
                            style={styles.branchDeleteBtn}
                            onClick={(e) => { e.stopPropagation(); handleDeleteBranch(b.name); }}
                            title="Delete branch"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}

                    {filteredBranches.length === 0 && branchFilter && (
                      <div style={{ padding: "8px 12px", fontSize: 12, color: "#9ca3af" }}>No branches match</div>
                    )}
                  </div>

                  {/* New branch */}
                  {/* New branch — only when repo has commits */}
                  {isOwner && branches.length > 0 && (
                    <div style={styles.branchMenuCreate}>
                      <label style={{ ...styles.branchMenuGroupLabel, display: "block", marginBottom: 6 }}>
                        New branch from
                        <select
                          value={
                            branchCreateFrom && branches.some((b) => b.name === branchCreateFrom)
                              ? branchCreateFrom
                              : (selectedBranch ?? defaultBranchName ?? branches[0]!.name)
                          }
                          onChange={(e) => setBranchCreateFrom(e.target.value)}
                          style={{ ...styles.branchMenuInput, width: "100%", marginTop: 4, boxSizing: "border-box" }}
                        >
                          {branches.map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name}{b.isDefault ? " (default)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div style={{ display: "flex", gap: 6, padding: "6px 10px" }}>
                        <input
                          placeholder="branch-name"
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleCreateBranch()}
                          style={styles.branchMenuInput}
                        />
                        <button
                          style={styles.branchCreateBtn}
                          disabled={!newBranchName.trim() || creatingBranch}
                          onClick={handleCreateBranch}
                        >
                          {creatingBranch ? "…" : "Create"}
                        </button>
                      </div>
                      {branchError && <div style={{ padding: "0 10px 8px", fontSize: 11, color: "#ef4444" }}>{branchError}</div>}
                    </div>
                  )}
                  {isOwner && branches.length === 0 && (
                    <div style={{ padding: "10px 12px", fontSize: 12, color: "#9ca3af", borderTop: "1px solid #f3f4f6" }}>
                      Push a commit first to create branches.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Branch + tag counts */}
            {branches.length > 0 && (
              <div style={styles.repoStats}>
                <span>⎇ {branches.length} branch{branches.length !== 1 ? "es" : ""}</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>◈ {tags.length} tag{tags.length !== 1 ? "s" : ""}</span>
              </div>
            )}

            {/* Clone */}
            <div style={styles.cloneRow}>
              <span style={styles.cloneLabel}>clone</span>
              <code style={styles.cloneUrl}>{cloneUrl}</code>
              <button style={styles.copyBtn} onClick={() => navigator.clipboard.writeText(cloneUrl)} title="Copy">⎘</button>
            </div>
          </div>
        )}
      </div>

      <div style={styles.body}>
        {/* ── Pull Requests tab ── */}
        {activeTab === "pulls" && (
          <div style={styles.pullsPanel}>
            {/* PR list */}
            <div style={styles.prList}>
              <div style={styles.prListHeader}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Pull Requests</span>
                <button style={styles.newPrBtn} onClick={() => { setPrError(null); setShowNewPr(true); }}>+ New</button>
              </div>
              <div style={{ display: "flex", gap: 4, padding: "6px 12px", borderBottom: "1px solid #f3f4f6" }}>
                {(["open", "merged", "closed", "all"] as const).map((f) => (
                  <button
                    key={f}
                    style={{ ...styles.filterBtn, ...(pullsFilter === f ? styles.filterBtnActive : {}) }}
                    onClick={() => { setPullsFilter(f); loadPulls(f); }}
                  >
                    {f}
                  </button>
                ))}
              </div>
              {pullsLoading && <p style={{ ...styles.muted, padding: "8px 12px" }}>Loading…</p>}
              {!pullsLoading && pulls.length === 0 && (
                <p style={{ ...styles.muted, padding: "8px 12px" }}>No {pullsFilter === "all" ? "" : pullsFilter} pull requests.</p>
              )}
              {pulls.map((pr) => (
                <button
                  key={pr.id}
                  style={{ ...styles.prItem, ...(selectedPr?.id === pr.id ? styles.prItemActive : {}) }}
                  onClick={() => { setSelectedPr(pr); setPrConflict(false); setPrError(null); }}
                >
                  <span style={{ ...styles.prStateDot, backgroundColor: pr.state === "open" ? "#22c55e" : pr.state === "merged" ? "#a78bfa" : "#9ca3af" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      #{pr.number} {pr.title}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {pr.fromBranch} → {pr.toBranch} · {pr.author}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* PR detail */}
            <div style={styles.prDetail}>
              {showNewPr ? (
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>New Pull Request</h3>
                  <label style={styles.prFormLabel}>
                    From branch
                    <select
                      value={newPrFrom}
                      onChange={(e) => setNewPrFrom(e.target.value)}
                      style={styles.prFormInput}
                    >
                      <option value="">— select —</option>
                      {branches
                        .filter((b) => b.name !== newPrTo)
                        .map((b) => (
                          <option key={b.name} value={b.name}>
                            {b.name}{b.isDefault ? " (default)" : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label style={styles.prFormLabel}>
                    Into
                    <select
                      value={newPrTo}
                      onChange={(e) => setNewPrTo(e.target.value)}
                      style={styles.prFormInput}
                    >
                      {branches.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}{b.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={styles.prFormLabel}>
                    Title
                    <input
                      value={newPrTitle}
                      onChange={(e) => setNewPrTitle(e.target.value)}
                      placeholder="Title…"
                      style={styles.prFormInput}
                    />
                  </label>
                  <label style={styles.prFormLabel}>
                    Description
                    <textarea
                      value={newPrDesc}
                      onChange={(e) => setNewPrDesc(e.target.value)}
                      placeholder="Optional description…"
                      rows={3}
                      style={{ ...styles.prFormInput, resize: "vertical" }}
                    />
                  </label>
                  {branches.length < 2 && (
                    <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>
                      You need at least two branches to open a pull request.
                    </p>
                  )}
                  {prError && <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{prError}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      style={styles.mergeBtn}
                      disabled={
                        prActionLoading
                        || !newPrTitle.trim()
                        || !newPrFrom
                        || !newPrTo
                        || newPrFrom === newPrTo
                        || branches.length < 2
                      }
                      onClick={handleCreatePr}
                    >
                      {prActionLoading ? "Creating…" : "Create PR"}
                    </button>
                    <button style={styles.closeBtn} onClick={() => { setShowNewPr(false); setNewPrTo(""); }}>Cancel</button>
                  </div>
                </div>
              ) : selectedPr ? (
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ ...styles.prStateDot, width: 10, height: 10, backgroundColor: selectedPr.state === "open" ? "#22c55e" : selectedPr.state === "merged" ? "#a78bfa" : "#9ca3af" }} />
                    <h3 style={{ margin: 0, fontSize: 15, flex: 1 }}>#{selectedPr.number} {selectedPr.title}</h3>
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    <strong>{selectedPr.fromBranch}</strong> → <strong>{selectedPr.toBranch}</strong>
                    {" · "} by {selectedPr.author}
                    {" · "} {new Date(selectedPr.createdAt).toLocaleDateString()}
                  </div>
                  {selectedPr.description && (
                    <p style={{ fontSize: 13, color: "#374151", margin: 0, lineHeight: 1.5 }}>{selectedPr.description}</p>
                  )}
                  {selectedPr.mergedAt && (
                    <div style={{ fontSize: 12, color: "#7c3aed" }}>Merged {new Date(selectedPr.mergedAt).toLocaleString()}</div>
                  )}
                  {prError && !prConflict && (
                    <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{prError}</p>
                  )}
                  {prConflict && selectedPr.state === "open" && (
                    <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "#b91c1c" }}>
                        ⚠ Merge conflict — the branches have conflicting changes to the same files or entities.
                      </p>
                      <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
                        Choose which branch&apos;s version wins for all conflicting paths, or open the diff viewer to compare <strong>{selectedPr.toBranch}</strong> (current) vs <strong>{selectedPr.fromBranch}</strong> (incoming) per file:
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <button
                          type="button"
                          style={{ ...styles.mergeBtn, fontSize: 12 }}
                          disabled={prActionLoading || mergeReviewFromLoading}
                          onClick={() => void handleOpenMergeResolveEditor(selectedPr)}
                        >
                          {mergeReviewFromLoading ? "Loading…" : "Resolve in editor"}
                        </button>
                        <button
                          style={{ ...styles.closeBtn, background: "#1e3a5f", color: "#fff", fontSize: 12 }}
                          disabled={prActionLoading}
                          onClick={() => handleResolveConflict(selectedPr, "theirs")}
                          title={`Keep ${selectedPr.fromBranch}'s version of conflicting entities`}
                        >
                          {prActionLoading ? "Resolving…" : `Keep all from ${selectedPr.fromBranch}`}
                        </button>
                        <button
                          style={{ ...styles.closeBtn, fontSize: 12 }}
                          disabled={prActionLoading}
                          onClick={() => handleResolveConflict(selectedPr, "ours")}
                          title={`Keep ${selectedPr.toBranch}'s version of conflicting entities`}
                        >
                          {prActionLoading ? "Resolving…" : `Keep all from ${selectedPr.toBranch}`}
                        </button>
                      </div>
                    </div>
                  )}
                  {selectedPr.state === "open" && !prConflict && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        style={styles.mergeBtn}
                        disabled={prActionLoading}
                        onClick={() => handleMergePr(selectedPr)}
                      >
                        {prActionLoading ? "Merging…" : "Merge PR"}
                      </button>
                      <button
                        style={styles.closeBtn}
                        disabled={prActionLoading}
                        onClick={() => handleClosePr(selectedPr)}
                      >
                        Close
                      </button>
                    </div>
                  )}
                  {selectedPr.state === "open" && prConflict && !prActionLoading && (
                    <button
                      style={{ ...styles.closeBtn, alignSelf: "flex-start" }}
                      onClick={() => { setPrConflict(false); setPrError(null); }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ padding: 24, color: "#9ca3af", fontSize: 13 }}>Select a pull request to view details.</div>
              )}
            </div>
          </div>
        )}

        {activeTab === "code" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
            {mergeReviewPr && (
              <div style={styles.mergeReviewBanner}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>Merge review</strong>
                  {" — "}
                  PR #{mergeReviewPr.number}: comparing <strong>{mergeReviewPr.toBranch}</strong> (current) with{" "}
                  <strong>{mergeReviewPr.fromBranch}</strong> (incoming). Use <strong>Diff</strong> and{" "}
                  <strong>Old / Both / New</strong> in the viewer (text and 3D); switch files in the sidebar to inspect each path.
                  Pick <strong>base</strong> or <strong>incoming</strong> per change in the editor, then use <strong>Complete merge with picks</strong>.
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    style={styles.mergeReviewBannerBtn}
                    disabled={prActionLoading}
                    onClick={() => void handleCompleteGranularMerge(mergeReviewPr)}
                  >
                    {prActionLoading ? "Merging…" : "Complete merge with picks"}
                  </button>
                  {prConflict && (
                    <>
                      <button
                        type="button"
                        style={{ ...styles.mergeReviewBannerBtn, background: "#1e3a5f" }}
                        disabled={prActionLoading}
                        onClick={() => void handleResolveConflict(mergeReviewPr, "theirs")}
                      >
                        {prActionLoading ? "Resolving…" : `Keep all from ${mergeReviewPr.fromBranch}`}
                      </button>
                      <button
                        type="button"
                        style={styles.mergeReviewBannerBtnSecondary}
                        disabled={prActionLoading}
                        onClick={() => void handleResolveConflict(mergeReviewPr, "ours")}
                      >
                        {prActionLoading ? "Resolving…" : `Keep all from ${mergeReviewPr.toBranch}`}
                      </button>
                    </>
                  )}
                  <button type="button" style={styles.mergeReviewBannerBtn} onClick={() => { setActiveTab("pulls"); setSearchParams((p) => { p.set("tab", "pulls"); return p; }, { replace: true }); }}>
                    Back to PR
                  </button>
                  <button type="button" style={styles.mergeReviewBannerBtnSecondary} onClick={handleClearMergeReview}>
                    Exit merge review
                  </button>
                </div>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "row" }}>
            <CodeWorkspace
            workspaceHandlerId={workspaceHandlerId}
            loadingSnap={loadingSnap}
            diffLoading={diffLoading}
            modules={modules}
            selectedModuleFile={selectedModuleFile}
            setSelectedModuleFile={setSelectedModuleFile}
            activeSnapshot={activeSnapshot}
            activeCommitId={activeCommitId}
            selectionPath={selectionPath}
            setSelectionPath={setSelectionPath}
            diffResult={diffResult}
            diffMode={diffMode}
            setDiffMode={setDiffMode}
            ghostSelectedId={ghostSelectedId}
            setGhostSelectedId={setGhostSelectedId}
            commitGroups={workspaceCommitGroups}
            expandedCommitKey={expandedCommitKey}
            commitFilePreviews={commitFilePreviews}
            commitChangedFileCountByKey={commitChangedFileCountByKey}
            commitChangedFileCountLoadingByKey={commitChangedFileCountLoadingByKey}
            changedCommitKeysForSelectedFile={changedCommitKeysForSelectedFile}
            changedCommitKeysForSelectedFileLoading={changedCommitKeysForSelectedFileLoading}
            onCommitGroupToggle={handleCommitGroupToggle}
            onPickSnapshotFromCommit={onPickSnapshotFromCommit}
            handleModuleClick={handleModuleClick}
            loadCommit={loadCommit}
            mergeReviewPr={mergeReviewPr}
            mergeReviewFromLoading={mergeReviewFromLoading}
            onClearMergeReview={handleClearMergeReview}
            mergeTextHunkSides={currentTextHunkSides}
            onMergeTextHunkSide={mergeReviewPr ? setTextHunkSide : undefined}
            mergeGltfEntitySides={currentGltfEntitySides}
            onMergeGltfEntitySide={mergeReviewPr ? setGltfEntitySide : undefined}
            mergeGltfFieldSides={currentGltfFieldSides}
            onMergeGltfFieldSide={mergeReviewPr ? setGltfFieldSide : undefined}
            />
            </div>
          </div>
        )}
      </div>

      {error && <p style={styles.errorMsg}>{error}</p>}
    </div>
  );
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const styles: Record<string, CSSProperties> = {
  shell: { display: "flex", flexDirection: "column", height: "100vh", backgroundColor: "#f9fafb" },

  // Row 1
  topbar: { display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", backgroundColor: "#fff", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  backBtn: { fontSize: 16, color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", lineHeight: 1 },
  breadcrumb: { display: "flex", alignItems: "center", gap: 4 },
  breadcrumbOwner: { fontSize: 14, color: "#6b7280", fontWeight: 500, cursor: "default" },
  breadcrumbSep:   { fontSize: 14, color: "#d1d5db" },
  breadcrumbRepo:  { fontSize: 14, color: "#111827", fontWeight: 700 },
  visibilityBadge: { fontSize: 11, color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 10, padding: "1px 8px", fontWeight: 500 },
  actionBtns: { display: "flex", alignItems: "center", gap: 8 },
  actionBtn:  { display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 500, color: "#374151", background: "#f9fafb", border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 12px", cursor: "pointer" },
  actionBtnDisabled: { opacity: 0.45, cursor: "not-allowed" },

  // Row 2
  subnav: { display: "flex", alignItems: "center", gap: 0, padding: "0 20px", backgroundColor: "#fff", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  navTabs: { display: "flex", gap: 0 },
  navTab:  { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: "#6b7280", background: "none", border: "none", borderBottom: "2px solid transparent", padding: "10px 14px", cursor: "pointer", whiteSpace: "nowrap" as const },
  navTabActive: { color: "#111827", borderBottomColor: "#f97316", fontWeight: 600 },
  navTabIcon:   { fontSize: 12, fontFamily: MONO },
  navTabBadge:  { fontSize: 11, fontWeight: 600, background: "#f97316", color: "#fff", borderRadius: 10, padding: "0 6px", minWidth: 18, textAlign: "center" as const },
  codeToolbar: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0" },

  // Branch dropdown
  branchBtn: { display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "#111827", background: "#f6f8fa", border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 12px", cursor: "pointer", whiteSpace: "nowrap" as const },
  branchBtnIcon: { fontSize: 14 },
  branchMenu: { position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 100, width: 280, background: "#fff", border: "1px solid #d1d5db", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden" },
  branchMenuHeader: { padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#6b7280", borderBottom: "1px solid #f3f4f6", textAlign: "center" as const },
  branchMenuSearch: { padding: "8px 10px", borderBottom: "1px solid #f3f4f6" },
  branchMenuInput:  { width: "100%", fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 8px", outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" },
  branchMenuList:   { maxHeight: 220, overflowY: "auto" as const },
  branchMenuGroupLabel: { fontSize: 11, fontWeight: 600, color: "#9ca3af", padding: "6px 12px 2px", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
  branchMenuRow:    { display: "flex", alignItems: "center" },
  branchMenuItem:   { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 12px", fontSize: 13, color: "#111827", background: "none", border: "none", cursor: "pointer", textAlign: "left" as const },
  branchMenuItemActive: { background: "#f0f9ff", fontWeight: 600 },
  branchMenuCheck:  { width: 14, fontSize: 12, color: "#3b82f6", flexShrink: 0 },
  branchDefaultBadge: { fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px", fontWeight: 600 },
  branchDeleteBtn:  { fontSize: 12, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "6px 10px", flexShrink: 0 },
  branchMenuCreate: { borderTop: "1px solid #f3f4f6" },
  branchCreateBtn:  { fontSize: 12, fontWeight: 600, color: "#fff", background: "#2563eb", border: "none", borderRadius: 5, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" as const },

  // Repo stats
  repoStats: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" as const },

  // Clone
  cloneRow:   { display: "flex", alignItems: "center", gap: 6, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 8px" },
  cloneLabel: { fontSize: 10, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
  cloneUrl:   { fontSize: 12, color: "#334155", fontFamily: MONO, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  copyBtn:    { fontSize: 14, color: "#64748b", background: "none", border: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1 },

  body: { display: "flex", flex: 1, overflow: "hidden" },
  mergeReviewBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    flexShrink: 0,
    padding: "10px 16px",
    fontSize: 13,
    lineHeight: 1.45,
    color: "#78350f",
    background: "#fffbeb",
    borderBottom: "1px solid #fcd34d",
  },
  mergeReviewBannerBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: "#fff",
    background: "#b45309",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  mergeReviewBannerBtnSecondary: {
    fontSize: 12,
    fontWeight: 500,
    color: "#78350f",
    background: "#fff",
    border: "1px solid #d97706",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },

  muted: { fontSize: 12, color: "#9ca3af", margin: 0 },

  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0, borderTop: "1px solid #fee2e2", backgroundColor: "#fff1f2" },


  // PR panel
  pullsPanel:   { display: "flex", flex: 1, overflow: "hidden" },
  prList:       { width: 320, borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" },
  prListHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px 8px", borderBottom: "1px solid #f3f4f6" },
  newPrBtn:     { fontSize: 12, fontWeight: 600, color: "#3b82f6", background: "none", border: "1px solid #bfdbfe", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  filterBtn:    { fontSize: 11, color: "#6b7280", background: "none", border: "1px solid transparent", borderRadius: 4, padding: "2px 8px", cursor: "pointer" },
  filterBtnActive: { color: "#111827", background: "#f1f5f9", border: "1px solid #e5e7eb" },
  prItem:       { display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 14px", background: "none", border: "none", borderBottom: "1px solid #f3f4f6", cursor: "pointer", textAlign: "left", width: "100%" },
  prItemActive: { backgroundColor: "#f0f9ff" },
  prStateDot:   { width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 4 },
  prDetail:     { flex: 1, overflowY: "auto" },
  prFormLabel:  { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#374151", fontWeight: 500 },
  prFormInput:  { fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 6, padding: "6px 10px", outline: "none", width: "100%", boxSizing: "border-box" },
  mergeBtn:     { fontSize: 13, fontWeight: 600, color: "#fff", background: "#22c55e", border: "none", borderRadius: 6, padding: "7px 18px", cursor: "pointer" },
  closeBtn:     { fontSize: 13, fontWeight: 600, color: "#6b7280", background: "#f3f4f6", border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer" },
};
