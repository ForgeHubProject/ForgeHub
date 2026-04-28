import { useEffect, useMemo, useState } from "react";
import { API_BASE, closePull, compareDiff, createPull, forkRepo, getSnapshot, getSnapshots, listBranches, listPulls, mergePull } from "../api";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import type { BranchInfo, DiffChange, DiffResult, Entity, PullRequest, Repo, Snapshot, SnapshotSummary, User } from "../types";

type Props = {
  token: string;
  user: User;
  repo: Repo;
  onBack: () => void;
};

type Module = {
  sourceFile: string;
  displayName: string;
  commits: SnapshotSummary[]; // sorted oldest → newest
};

const DIFF_COLOR: Record<string, string> = {
  added:     "#22c55e",
  removed:   "#ef4444",
  modified:  "#f59e0b",
  moved:     "#f97316",
  unchanged: "#94a3b8",
};

const DIFF_ICON: Record<string, string> = {
  added:    "+",
  removed:  "−",
  modified: "~",
  moved:    "↔",
};

export function SnapshotPage({ token, user, repo, onBack }: Props) {
  const [snapshots, setSnapshots]           = useState<SnapshotSummary[]>([]);
  const [selectedModuleFile, setSelectedModuleFile] = useState<string | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<Snapshot | null>(null);
  const [activeCommitId, setActiveCommitId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds]       = useState<string[]>([]);
  const [loadingSnap, setLoadingSnap]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);

  const [diffResult, setDiffResult]   = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMode, setDiffMode]       = useState(true);
  const [ghostSelectedId, setGhostSelectedId] = useState<string | null>(null);

  // Branch selector
  const [branches, setBranches]           = useState<BranchInfo[]>([]);
  const [defaultBranchName, setDefaultBranchName] = useState<string>("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  // Tab: "code" | "pulls"
  const [activeTab, setActiveTab] = useState<"code" | "pulls">("code");

  // Pull requests
  const [pulls, setPulls]                 = useState<PullRequest[]>([]);
  const [pullsLoading, setPullsLoading]   = useState(false);
  const [selectedPr, setSelectedPr]       = useState<PullRequest | null>(null);
  const [prActionLoading, setPrActionLoading] = useState(false);
  const [prError, setPrError]             = useState<string | null>(null);
  const [showNewPr, setShowNewPr]         = useState(false);
  const [newPrTitle, setNewPrTitle]       = useState("");
  const [newPrFrom, setNewPrFrom]         = useState("");
  const [newPrDesc, setNewPrDesc]         = useState("");
  const [pullsFilter, setPullsFilter]     = useState<"open" | "merged" | "closed" | "all">("open");

  const [forking, setForking]     = useState(false);
  const [forkMsg, setForkMsg]     = useState<string | null>(null);

  const handle    = repo.ownerHandle ?? user.handle;
  const repoName  = repo.name;
  const cloneUrl  = `${API_BASE}/git/${handle}/${repoName}.git`;
  const isOwner   = handle === user.handle;

  // Group snapshots by sourceFile → Modules
  const modules = useMemo<Module[]>(() => {
    const map = new Map<string, SnapshotSummary[]>();
    for (const s of snapshots) {
      if (!map.has(s.sourceFile)) map.set(s.sourceFile, []);
      map.get(s.sourceFile)!.push(s);
    }
    return Array.from(map.entries()).map(([sourceFile, commits]) => ({
      sourceFile,
      displayName: sourceFile.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
      commits: [...commits].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }));
  }, [snapshots]);

  // Commits shown in right panel (newest first)
  const visibleCommits = useMemo<SnapshotSummary[]>(() => {
    const list = selectedModuleFile
      ? (modules.find((m) => m.sourceFile === selectedModuleFile)?.commits ?? [])
      : [...snapshots].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return [...list].reverse(); // newest first for display
  }, [selectedModuleFile, modules, snapshots]);

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
      const r = await listBranches(token, handle, repoName);
      setBranches(r.branches);
      setDefaultBranchName(r.defaultBranch);
    } catch { /* ignore if no git storage yet */ }
  }

  async function loadPulls(filter: typeof pullsFilter = pullsFilter) {
    setPullsLoading(true);
    setPrError(null);
    try {
      const r = await listPulls(token, handle, repoName, filter);
      setPulls(r.pulls);
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Failed to load PRs");
    } finally {
      setPullsLoading(false);
    }
  }

  async function handleMergePr(pr: PullRequest) {
    setPrActionLoading(true);
    setPrError(null);
    try {
      await mergePull(token, handle, repoName, pr.number);
      setSelectedPr({ ...pr, state: "merged" });
      await loadPulls();
      await refreshSnapshots();
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setPrActionLoading(false);
    }
  }

  async function handleClosePr(pr: PullRequest) {
    setPrActionLoading(true);
    setPrError(null);
    try {
      await closePull(token, handle, repoName, pr.number);
      setSelectedPr({ ...pr, state: "closed" });
      await loadPulls();
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
    if (!newPrTitle.trim() || !newPrFrom) return;
    setPrActionLoading(true);
    setPrError(null);
    try {
      const pr = await createPull(token, handle, repoName, newPrTitle.trim(), newPrFrom, defaultBranchName || undefined, newPrDesc || undefined);
      setShowNewPr(false);
      setNewPrTitle(""); setNewPrFrom(""); setNewPrDesc("");
      await loadPulls();
      setSelectedPr(pr);
    } catch (e) {
      setPrError(e instanceof Error ? e.message : "Failed to create PR");
    } finally {
      setPrActionLoading(false);
    }
  }

  // Auto-load latest snapshot + branches on mount
  useEffect(() => {
    loadBranches();
  }, [handle, repoName]);

  useEffect(() => {
    let cancelled = false;
    setLoadingSnap(true);
    setError(null);

    getSnapshots(token, handle, repoName)
      .then(async (r) => {
        if (cancelled) return;
        setSnapshots(r.snapshots);
        const latest = r.snapshots[0];
        if (!latest) { setActiveSnapshot(null); return; }
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
  }, [token, handle, repoName]);

  async function loadCommit(commitId: string, moduleCommits: SnapshotSummary[]) {
    setLoadingSnap(true);
    setError(null);
    setDiffResult(null);

    // moduleCommits is sorted oldest→newest; find predecessor
    const sorted = [...moduleCommits].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const idx = sorted.findIndex((c) => c.id === commitId);
    const predecessor = idx > 0 ? sorted[idx - 1] : null;

    try {
      const snap = await getSnapshot(token, handle, repoName, commitId);
      setActiveSnapshot(snap);
      setActiveCommitId(commitId);
      setSelectedIds([]);
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

  async function handleBranchChange(branch: string) {
    const b = branch === "__all__" ? null : branch;
    setSelectedBranch(b);
    setActiveSnapshot(null);
    setActiveCommitId(null);
    setDiffResult(null);
    setSelectedIds([]);
    setLoadingSnap(true);
    setError(null);
    try {
      const r = await getSnapshots(token, handle, repoName, b ?? undefined);
      setSnapshots(r.snapshots);
      const latest = r.snapshots[0];
      if (latest) {
        const snap = await getSnapshot(token, handle, repoName, latest.id);
        setActiveSnapshot(snap);
        setActiveCommitId(latest.id);
        setSelectedModuleFile(latest.sourceFile);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoadingSnap(false);
    }
  }

  function handleModuleClick(sourceFile: string) {
    setSelectedModuleFile(sourceFile);
    const mod = modules.find((m) => m.sourceFile === sourceFile);
    if (mod && mod.commits.length > 0) {
      const latest = mod.commits[mod.commits.length - 1];
      loadCommit(latest.id, mod.commits);
    }
  }

  const selectedEntity =
    selectedIds.length === 1
      ? activeSnapshot?.entities.find((e) => e.id === selectedIds[0])
      : null;

  // Works for both live entities and ghost (removed) entities
  const selectedChange = useMemo(() => {
    if (!diffResult) return null;
    if (ghostSelectedId) return diffResult.changes.find((c) => c.entityId === ghostSelectedId) ?? null;
    if (selectedEntity) return diffResult.changes.find((c) => c.entityId === selectedEntity.entityId) ?? null;
    return null;
  }, [diffResult, ghostSelectedId, selectedEntity]);

  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <button onClick={onBack} style={styles.backBtn}>← Repos</button>
        <span style={styles.repoTitle}>{repo.fullName ?? repo.name}</span>
        <span style={styles.visibility}>{repo.visibility}</span>

        {/* Branch selector */}
        {branches.length > 0 && (
          <select
            value={selectedBranch ?? "__all__"}
            onChange={(e) => handleBranchChange(e.target.value)}
            style={styles.branchSelect}
          >
            <option value="__all__">All branches</option>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.isDefault ? `${b.name} (default)` : b.name}
                {b.protected ? " 🔒" : ""}
              </option>
            ))}
          </select>
        )}

        {/* Tab bar */}
        <div style={styles.tabBar}>
          <button
            style={{ ...styles.tabBtn, ...(activeTab === "code" ? styles.tabBtnActive : {}) }}
            onClick={() => setActiveTab("code")}
          >
            Code
          </button>
          <button
            style={{ ...styles.tabBtn, ...(activeTab === "pulls" ? styles.tabBtnActive : {}) }}
            onClick={() => { setActiveTab("pulls"); loadPulls(); }}
          >
            Pull Requests
          </button>
        </div>

        <div style={styles.cloneRow}>
          <span style={styles.cloneLabel}>clone</span>
          <code style={styles.cloneUrl}>{cloneUrl}</code>
          <button
            style={styles.copyBtn}
            onClick={() => navigator.clipboard.writeText(cloneUrl)}
            title="Copy clone URL"
          >
            ⎘
          </button>
        </div>
        {!isOwner && (
          <button
            onClick={handleFork}
            disabled={forking}
            style={styles.forkBtn}
            title="Fork this repository"
          >
            {forking ? "Forking…" : "⑂ Fork"}
          </button>
        )}
        {forkMsg && <span style={{ fontSize: 12, color: "#22c55e" }}>{forkMsg}</span>}

        <button
          onClick={() => refreshSnapshots()}
          disabled={loadingSnap}
          style={styles.refreshBtn}
          title="Refresh after git push"
        >
          ↻
        </button>
      </header>

      <div style={styles.body}>
        {/* ── Pull Requests tab ── */}
        {activeTab === "pulls" && (
          <div style={styles.pullsPanel}>
            {/* PR list */}
            <div style={styles.prList}>
              <div style={styles.prListHeader}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Pull Requests</span>
                <button style={styles.newPrBtn} onClick={() => setShowNewPr(true)}>+ New</button>
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
                  onClick={() => setSelectedPr(pr)}
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
                      {branches.filter((b) => !b.isDefault).map((b) => (
                        <option key={b.name} value={b.name}>{b.name}</option>
                      ))}
                    </select>
                  </label>
                  <label style={styles.prFormLabel}>
                    Into
                    <input readOnly value={defaultBranchName || "(default)"} style={{ ...styles.prFormInput, opacity: 0.6 }} />
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
                  {prError && <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{prError}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      style={styles.mergeBtn}
                      disabled={prActionLoading || !newPrTitle.trim() || !newPrFrom}
                      onClick={handleCreatePr}
                    >
                      {prActionLoading ? "Creating…" : "Create PR"}
                    </button>
                    <button style={styles.closeBtn} onClick={() => setShowNewPr(false)}>Cancel</button>
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
                  {prError && <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{prError}</p>}
                  {selectedPr.state === "open" && (
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
                </div>
              ) : (
                <div style={{ padding: 24, color: "#9ca3af", fontSize: 13 }}>Select a pull request to view details.</div>
              )}
            </div>
          </div>
        )}

        {/* ── Left sidebar ── */}
        {activeTab === "code" && (<>
        <aside style={styles.sidebar}>

          {/* Modules */}
          <div style={styles.sideSection}>
            <div style={styles.sideSectionHeader}>
              <span>Modules</span>
              <span style={styles.muted}>{modules.length}</span>
            </div>
            {modules.length === 0 && <p style={{ ...styles.muted, padding: "6px 12px" }}>No modules found.</p>}
            {modules.map((mod) => {
              const isSelected = selectedModuleFile === mod.sourceFile;
              return (
                <button
                  key={mod.sourceFile}
                  style={{ ...styles.moduleBtn, ...(isSelected ? styles.moduleBtnSelected : {}) }}
                  onClick={() => handleModuleClick(mod.sourceFile)}
                >
                  <span style={styles.moduleIcon}>⬡</span>
                  <span style={styles.moduleName}>{mod.displayName}</span>
                  <span style={styles.moduleCommitCount}>{mod.commits.length}</span>
                </button>
              );
            })}
          </div>

          {/* Assembly tree */}
          {activeSnapshot && (
            <div style={{ ...styles.sideSection, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={styles.sideSectionHeader}>
                <span>Assembly</span>
                <span style={styles.muted}>{activeSnapshot.entities.length}</span>
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                <ModuleTree
                  entities={activeSnapshot.entities}
                  constraints={activeSnapshot.constraints}
                  selectedIds={selectedIds}
                  onSelect={(id) => setSelectedIds([id])}
                />
              </div>
            </div>
          )}
        </aside>

        {/* ── 3D Viewport ── */}
        <main style={styles.viewport}>
          {loadingSnap ? (
            <div style={styles.viewportPlaceholder}>
              <p style={styles.viewportText}>Loading model…</p>
            </div>
          ) : activeSnapshot ? (
            <Viewport
              entities={activeSnapshot.entities}
              constraints={activeSnapshot.constraints}
              selectedIds={selectedIds}
              onSelect={(id) => { setSelectedIds([id]); setGhostSelectedId(null); }}
              onDeselect={() => { setSelectedIds([]); setGhostSelectedId(null); }}
              diffChanges={diffResult?.changes ?? null}
              diffMode={diffMode}
              onSelectGhost={(eid) => { setGhostSelectedId(eid); setSelectedIds([]); }}
            />
          ) : (
            <div style={styles.viewportPlaceholder}>
              <span style={styles.viewportIcon}>⬡</span>
              <p style={styles.viewportText}>No model to display</p>
              <p style={styles.viewportSub}>Import snapshots from your pipeline, then open this repo.</p>
            </div>
          )}

          {/* Diff / Normal toggle */}
          {activeSnapshot && diffResult && (
            <button style={styles.diffToggle} onClick={() => setDiffMode((d) => !d)}>
              {diffMode ? "◑ Diff" : "◐ Normal"}
            </button>
          )}

          {/* Changes overlay HUD */}
          {diffMode && diffResult && activeSnapshot && (
            <div style={styles.changesOverlay}>
              <div style={styles.overlayHeader}>
                <span>Changes</span>
                <div style={{ display: "flex", gap: 3 }}>
                  {diffResult.summary.added    > 0 && <span style={diffCountStyle(DIFF_COLOR.added)}>+{diffResult.summary.added}</span>}
                  {diffResult.summary.removed  > 0 && <span style={diffCountStyle(DIFF_COLOR.removed)}>−{diffResult.summary.removed}</span>}
                  {diffResult.summary.modified > 0 && <span style={diffCountStyle(DIFF_COLOR.modified)}>~{diffResult.summary.modified}</span>}
                  {diffResult.summary.moved    > 0 && <span style={diffCountStyle(DIFF_COLOR.moved)}>↔{diffResult.summary.moved}</span>}
                </div>
              </div>
              {diffResult.changes.filter((c) => c.type !== "unchanged").map((c) => {
                const isSelected = ghostSelectedId === c.entityId || selectedEntity?.entityId === c.entityId;
                return (
                  <div
                    key={c.entityId}
                    style={{ ...styles.overlayRow, ...(isSelected ? styles.overlayRowSelected : {}) }}
                    onClick={() => {
                      if (c.type === "removed") {
                        setGhostSelectedId(c.entityId); setSelectedIds([]);
                      } else {
                        const match = activeSnapshot.entities.find((e) => e.entityId === c.entityId);
                        if (match) { setSelectedIds([match.id]); setGhostSelectedId(null); }
                      }
                    }}
                  >
                    <span style={{ color: DIFF_COLOR[c.type], fontWeight: 700, fontSize: 11, width: 12, flexShrink: 0 }}>
                      {DIFF_ICON[c.type]}
                    </span>
                    <span style={styles.overlayName}>{c.name}</span>
                    <span style={styles.overlayKind}>{c.kind}</span>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* ── Right panel ── */}
        <aside style={styles.rightPanel}>

          {/* Commits */}
          <div style={styles.commitsSection}>
            <div style={styles.sideSectionHeader}>
              <span>Commits</span>
              {selectedModuleFile && (
                <span style={styles.muted}>
                  {modules.find((m) => m.sourceFile === selectedModuleFile)?.displayName}
                </span>
              )}
            </div>
            {diffLoading && <p style={{ ...styles.muted, padding: "4px 12px" }}>Computing diff…</p>}
            {visibleCommits.length === 0 && (
              <p style={{ ...styles.muted, padding: "6px 12px" }}>No commits yet.</p>
            )}
            {visibleCommits.map((c, i) => {
              const isActive = activeCommitId === c.id;
              const hasDiff  = isActive && diffResult;
              const isLast   = i === visibleCommits.length - 1;
              const mod      = modules.find((m) => m.sourceFile === c.sourceFile);
              return (
                <button
                  key={c.id}
                  style={{ ...styles.commitBtn, ...(isActive ? styles.commitBtnActive : {}) }}
                  onClick={() => {
                    setSelectedModuleFile(c.sourceFile);
                    loadCommit(c.id, mod?.commits ?? [c]);
                  }}
                >
                  <div style={styles.commitTrack}>
                    <div style={{ ...styles.commitDot, ...(isActive ? styles.commitDotActive : {}) }} />
                    {!isLast && <div style={styles.commitLine} />}
                  </div>
                  <div style={styles.commitInfo}>
                    <span style={styles.commitMsg}>{c.label ?? c.sourceFile}</span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={styles.commitDate}>{new Date(c.createdAt).toLocaleDateString()}</span>
                      {c.gitCommitSha && (
                        <span style={styles.commitSha}>{c.gitCommitSha.slice(0, 7)}</span>
                      )}
                    </div>
                    {hasDiff && (
                      <div style={styles.commitDiffBadges}>
                        {diffResult!.summary.added    > 0 && <span style={diffBadgeStyle("#22c55e")}>+{diffResult!.summary.added}</span>}
                        {diffResult!.summary.removed  > 0 && <span style={diffBadgeStyle("#ef4444")}>−{diffResult!.summary.removed}</span>}
                        {diffResult!.summary.modified > 0 && <span style={diffBadgeStyle("#f59e0b")}>~{diffResult!.summary.modified}</span>}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Entity inspector */}
          {(selectedEntity || ghostSelectedId) ? (
            <EntityInspector
              entity={selectedEntity ?? null}
              change={selectedChange}
              diffMode={diffMode}
            />
          ) : (
            <div style={styles.rightPlaceholder}>
              Click a commit to explore its diff, or select an entity in the viewport.
            </div>
          )}
        </aside>
        </>)}
      </div>

      {error && <p style={styles.errorMsg}>{error}</p>}
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

type PropKind = "normal" | "changed" | "added" | "removed";
type PropRow  = { label: string; value: string; kind: PropKind; before?: string };

function EntityInspector({ entity, change, diffMode }: {
  entity: Entity | null;
  change: DiffChange | null;
  diffMode: boolean;
}) {
  const type       = change?.type;
  const isRemoved  = type === "removed";
  const isAdded    = type === "added";
  const isModified = type === "modified" || type === "moved";

  // For removed ghosts, fall back to the before-snapshot as data source
  const src = entity
    ? { name: entity.name, kind: entity.kind, path: entity.path, transform: entity.transform, attributes: entity.attributes }
    : isRemoved ? change!.before
    : null;

  if (!src) return <div style={styles.rightPlaceholder}>No data.</div>;

  const globalKind: PropKind = !diffMode ? "normal" : isRemoved ? "removed" : isAdded ? "added" : "normal";
  const getfc = (field: string) => change?.fieldChanges.find((f) => f.field === field);

  const rows: PropRow[] = [];

  const push = (label: string, value: unknown, field?: string) => {
    const fc = field ? getfc(field) : null;
    rows.push({
      label,
      value: fmtVal(value),
      kind: !diffMode ? "normal" : fc ? "changed" : globalKind,
      before: fc && diffMode ? fmtVal(fc.before) : undefined,
    });
  };

  push("name", src.name, "name");
  push("kind", src.kind);
  push("path", src.path);
  if (src.transform) {
    push("position", src.transform.position, "position");
    push("rotation", src.transform.rotationEulerDeg, "rotation");
    push("scale",    src.transform.scale, "scale");
  }

  // Expand attributes per-key with fine-grained diff
  const attrFc     = getfc("attributes");
  const curAttrs   = src.attributes ?? {};
  const prevAttrs  = (attrFc?.before ?? {}) as Record<string, unknown>;
  const nextAttrs  = (attrFc?.after  ?? {}) as Record<string, unknown>;
  const allAttrKeys = new Set([...Object.keys(curAttrs), ...Object.keys(prevAttrs)]);

  for (const key of allAttrKeys) {
    const inPrev = key in prevAttrs;
    const inNext = key in nextAttrs;
    if (diffMode && attrFc && inPrev && !inNext) {
      rows.push({ label: key, value: fmtVal(prevAttrs[key]), kind: "removed" });
    } else {
      const val  = curAttrs[key] ?? prevAttrs[key];
      let kind: PropKind = globalKind;
      let before: string | undefined;
      if (diffMode && attrFc) {
        if (!inPrev && inNext)                                            kind = "added";
        else if (JSON.stringify(prevAttrs[key]) !== JSON.stringify(nextAttrs[key])) {
          kind = "changed"; before = fmtVal(prevAttrs[key]);
        }
      }
      rows.push({ label: key, value: fmtVal(val), kind, before });
    }
  }

  return (
    <div style={{ padding: "10px 12px", overflowY: "auto", flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{src.name}</span>
        {change && diffMode && (
          <span style={{ fontSize: 11, fontWeight: 700, color: DIFF_COLOR[type!] }}>
            {DIFF_ICON[type!]} {type}
          </span>
        )}
      </div>
      {rows.map((row, i) => (
        <div key={i} style={propRowStyle(row.kind)}>
          <span style={styles.paramKey}>{row.label}</span>
          <span style={styles.paramValue}>{row.value}</span>
          {row.before !== undefined && (
            <span style={{ fontSize: 10, color: DIFF_COLOR.removed, fontFamily: "monospace" }}>was: {row.before}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string")  return v;
  if (typeof v === "number")  return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (Array.isArray(v) && v.every((x) => typeof x === "number"))
    return (v as number[]).map((n) => n.toFixed(2)).join(", ");
  try { return JSON.stringify(v); } catch { return String(v); }
}

function propRowStyle(kind: PropKind): React.CSSProperties {
  const bg = kind === "changed" ? "#fef9c3"
    : kind === "added"   ? "#dcfce7"
    : kind === "removed" ? "#fee2e2"
    : "transparent";
  return { display: "grid", gap: 1, padding: "3px 6px", borderRadius: 4, marginBottom: 3, backgroundColor: bg, borderBottom: "1px solid #f1f5f9" };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function diffCountStyle(color: string): React.CSSProperties {
  return {
    fontSize: 10, fontWeight: 700, color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 4, padding: "1px 5px",
  };
}

function diffBadgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 10, fontWeight: 700, color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 3, padding: "0 4px",
  };
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell:   { display: "flex", flexDirection: "column", height: "100vh", backgroundColor: "#f9fafb" },
  topbar:  { display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", backgroundColor: "#fff", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  backBtn: { fontSize: 13, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  repoTitle:  { fontSize: 15, fontWeight: 600, color: "#111827" },
  visibility: { fontSize: 11, color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 10, padding: "1px 8px" },
  cloneRow:   { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 8px" },
  cloneLabel: { fontSize: 10, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
  cloneUrl:   { fontSize: 12, color: "#334155", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  copyBtn:    { fontSize: 14, color: "#64748b", background: "none", border: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1 },
  refreshBtn: { fontSize: 16, color: "#64748b", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "3px 8px", cursor: "pointer" },
  body:    { display: "flex", flex: 1, overflow: "hidden" },

  sidebar: { width: 240, borderRight: "1px solid #e5e7eb", backgroundColor: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" },
  sideSection:       { borderBottom: "1px solid #f3f4f6", padding: "10px 0" },
  sideSectionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px 6px", fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" },
  muted: { fontSize: 12, color: "#9ca3af", margin: 0 },

  moduleBtn: {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
    textAlign: "left", borderRadius: 0,
  },
  moduleBtnSelected: { backgroundColor: "#f0f9ff" },
  moduleIcon:        { fontSize: 13, color: "#6b7280", flexShrink: 0 },
  moduleName:        { fontSize: 13, color: "#111827", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  moduleCommitCount: { fontSize: 11, color: "#9ca3af", flexShrink: 0 },

  viewport: { flex: 1, overflow: "hidden", position: "relative" },
  diffToggle: { position: "absolute", top: 12, right: 88, zIndex: 10, fontSize: 12, fontWeight: 600, color: "#e2e8f0", background: "rgba(15,23,42,0.75)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", backdropFilter: "blur(4px)" },
  changesOverlay: { position: "absolute", bottom: 28, left: 12, zIndex: 10, background: "rgba(15,23,42,0.85)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, minWidth: 200, maxWidth: 260, maxHeight: 260, overflowY: "auto", backdropFilter: "blur(6px)" },
  overlayHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid rgba(255,255,255,0.08)" },
  overlayRow:         { display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", cursor: "pointer" },
  overlayRowSelected: { backgroundColor: "rgba(255,255,255,0.08)" },
  overlayName: { fontSize: 12, color: "#e2e8f0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  overlayKind: { fontSize: 10, color: "#64748b", flexShrink: 0 },
  viewportPlaceholder: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#9ca3af" },
  viewportIcon: { fontSize: 64, display: "block", marginBottom: 12 },
  viewportText: { fontSize: 18, fontWeight: 600, color: "#6b7280", margin: 0 },
  viewportSub:  { fontSize: 13, color: "#9ca3af", marginTop: 6 },

  rightPanel: { width: 300, borderLeft: "1px solid #e5e7eb", backgroundColor: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" },

  commitsSection: { borderBottom: "1px solid #f3f4f6", overflowY: "auto", maxHeight: 280, flexShrink: 0 },
  commitBtn: {
    display: "flex", alignItems: "flex-start", gap: 8, width: "100%",
    padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
    textAlign: "left",
  },
  commitBtnActive: { backgroundColor: "#f0f9ff" },
  commitTrack: { display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4, flexShrink: 0, width: 12 },
  commitDot:       { width: 8, height: 8, borderRadius: "50%", backgroundColor: "#cbd5e1", flexShrink: 0 },
  commitDotActive: { backgroundColor: "#3b82f6" },
  commitLine:      { width: 2, flex: 1, backgroundColor: "#e5e7eb", minHeight: 8, marginTop: 2 },
  commitInfo: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  commitMsg:  { fontSize: 12, color: "#111827", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  commitDate: { fontSize: 10, color: "#9ca3af" },
  commitSha:  { fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", background: "#f1f5f9", borderRadius: 3, padding: "0 3px" },
  commitDiffBadges: { display: "flex", gap: 4, marginTop: 2 },

  rightPlaceholder: { fontSize: 12, color: "#9ca3af", padding: "12px", flex: 1 },
  paramTitle: { margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#111827" },
  paramList:  { display: "grid", gap: 8 },
  paramRow:   { display: "grid", gap: 2, paddingBottom: 6, borderBottom: "1px solid #f1f5f9" },
  paramKey:   { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" },
  paramValue: { fontSize: 12, color: "#0f172a", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0, borderTop: "1px solid #fee2e2", backgroundColor: "#fff1f2" },

  forkBtn:      { fontSize: 12, fontWeight: 600, color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  // Branch selector
  branchSelect: { fontSize: 12, color: "#374151", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 8px", background: "#fff", cursor: "pointer" },

  // Tab bar
  tabBar:       { display: "flex", gap: 2, background: "#f1f5f9", borderRadius: 8, padding: 2 },
  tabBtn:       { fontSize: 12, fontWeight: 500, color: "#6b7280", background: "none", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer" },
  tabBtnActive: { backgroundColor: "#fff", color: "#111827", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },

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
