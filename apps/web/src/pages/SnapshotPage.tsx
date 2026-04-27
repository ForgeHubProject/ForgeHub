import { useEffect, useMemo, useState } from "react";
import { compareDiff, getSnapshot, getSnapshots } from "../api";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import type { DiffChange, DiffResult, Entity, Repo, Snapshot, SnapshotSummary, User } from "../types";

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

  const handle   = repo.ownerHandle ?? user.handle;
  const repoName = repo.name;

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

  // Auto-load latest snapshot on mount
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

  const selectedDiffChange =
    selectedEntity && diffResult
      ? diffResult.changes.find((c) => c.entityId === selectedEntity.entityId)
      : null;

  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <button onClick={onBack} style={styles.backBtn}>← Repos</button>
        <span style={styles.repoTitle}>{repo.fullName ?? repo.name}</span>
        <span style={styles.visibility}>{repo.visibility}</span>
      </header>

      <div style={styles.body}>
        {/* ── Left sidebar ── */}
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
              onSelect={(id) => setSelectedIds([id])}
              diffChanges={diffResult?.changes ?? null}
            />
          ) : (
            <div style={styles.viewportPlaceholder}>
              <span style={styles.viewportIcon}>⬡</span>
              <p style={styles.viewportText}>No model to display</p>
              <p style={styles.viewportSub}>Import snapshots from your pipeline, then open this repo.</p>
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
                    <span style={styles.commitDate}>{new Date(c.createdAt).toLocaleDateString()}</span>
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

          {/* Diff change list */}
          {diffResult && (
            <div style={styles.diffPanel}>
              <div style={styles.sideSectionHeader}>
                <span>Changes</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {diffResult.summary.added    > 0 && <span style={diffCountStyle(DIFF_COLOR.added)}>+{diffResult.summary.added}</span>}
                  {diffResult.summary.removed  > 0 && <span style={diffCountStyle(DIFF_COLOR.removed)}>−{diffResult.summary.removed}</span>}
                  {diffResult.summary.modified > 0 && <span style={diffCountStyle(DIFF_COLOR.modified)}>~{diffResult.summary.modified}</span>}
                  {diffResult.summary.moved    > 0 && <span style={diffCountStyle(DIFF_COLOR.moved)}>↔{diffResult.summary.moved}</span>}
                </div>
              </div>
              <div style={styles.diffChangeList}>
                {diffResult.changes
                  .filter((c) => c.type !== "unchanged")
                  .map((c) => (
                    <div
                      key={c.entityId}
                      style={{
                        ...styles.diffChangeRow,
                        ...(selectedEntity?.entityId === c.entityId ? styles.diffChangeRowSelected : {}),
                      }}
                      onClick={() => {
                        const match = activeSnapshot?.entities.find((e) => e.entityId === c.entityId);
                        if (match) setSelectedIds([match.id]);
                      }}
                    >
                      <span style={{ color: DIFF_COLOR[c.type], fontWeight: 700, width: 14, flexShrink: 0 }}>
                        {DIFF_ICON[c.type]}
                      </span>
                      <span style={styles.diffChangeName}>{c.name}</span>
                      <span style={styles.diffChangeKind}>{c.kind}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Entity inspector */}
          {selectedDiffChange ? (
            <DiffInspector change={selectedDiffChange} />
          ) : selectedEntity ? (
            <ParameterInspector entity={selectedEntity} />
          ) : (
            <div style={styles.rightPlaceholder}>
              Click a commit to explore its diff, or select an entity in the viewport.
            </div>
          )}
        </aside>
      </div>

      {error && <p style={styles.errorMsg}>{error}</p>}
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function ParameterInspector({ entity }: { entity: Entity }) {
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={styles.sideSectionHeader}><span>Parameters</span></div>
      <p style={styles.paramTitle}>{entity.name}</p>
      <div style={styles.paramList}>
        {Object.entries(toParamMap(entity)).map(([key, value]) => (
          <div key={key} style={styles.paramRow}>
            <span style={styles.paramKey}>{key}</span>
            <span style={styles.paramValue}>{stringifyParam(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffInspector({ change }: { change: DiffChange }) {
  const color = DIFF_COLOR[change.type] ?? "#6b7280";
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={styles.sideSectionHeader}>
        <span>Change Details</span>
        <span style={{ color, fontWeight: 700, fontSize: 11 }}>
          {DIFF_ICON[change.type]} {change.type}
        </span>
      </div>
      <p style={styles.paramTitle}>{change.name}</p>
      <p style={{ fontSize: 11, color: "#6b7280", margin: "0 0 12px" }}>{change.kind}</p>
      {change.type === "added"   && <p style={{ fontSize: 12, color }}>New entity in this commit.</p>}
      {change.type === "removed" && <p style={{ fontSize: 12, color }}>Removed in this commit.</p>}
      {change.fieldChanges.length > 0 && (
        <>
          <p style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", margin: "8px 0 6px" }}>
            Changed Fields
          </p>
          {change.fieldChanges.map((fc, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#374151", fontWeight: 600, marginBottom: 2 }}>{fc.field}</div>
              <div style={{ display: "grid", gridTemplateColumns: "40px 1fr", gap: "3px 6px" }}>
                <span style={{ fontSize: 10, color: DIFF_COLOR.removed }}>before</span>
                <span style={styles.paramValue}>{stringifyParam(fc.before)}</span>
                <span style={{ fontSize: 10, color: DIFF_COLOR.added }}>after</span>
                <span style={styles.paramValue}>{stringifyParam(fc.after)}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toParamMap(entity: Entity): Record<string, unknown> {
  return {
    id: entity.id,
    entityId: entity.entityId,
    parentEntityId: entity.parentEntityId,
    kind: entity.kind,
    name: entity.name,
    path: entity.path,
    transform: entity.transform,
    renderRef: entity.renderRef,
    attributes: entity.attributes,
  };
}

function stringifyParam(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

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
  commitDiffBadges: { display: "flex", gap: 4, marginTop: 2 },

  diffPanel:      { borderBottom: "1px solid #f3f4f6", padding: "8px 0", flexShrink: 0 },
  diffChangeList: { display: "flex", flexDirection: "column" },
  diffChangeRow:         { display: "flex", alignItems: "center", gap: 6, padding: "3px 12px", cursor: "pointer" },
  diffChangeRowSelected: { backgroundColor: "#eff6ff" },
  diffChangeName: { fontSize: 12, color: "#111827", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  diffChangeKind: { fontSize: 10, color: "#9ca3af", flexShrink: 0 },

  rightPlaceholder: { fontSize: 12, color: "#9ca3af", padding: "12px", flex: 1 },
  paramTitle: { margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#111827" },
  paramList:  { display: "grid", gap: 8 },
  paramRow:   { display: "grid", gap: 2, paddingBottom: 6, borderBottom: "1px solid #f1f5f9" },
  paramKey:   { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" },
  paramValue: { fontSize: 12, color: "#0f172a", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0, borderTop: "1px solid #fee2e2", backgroundColor: "#fff1f2" },
};
