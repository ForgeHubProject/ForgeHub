import { useEffect, useState } from "react";
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
  const [activeSnapshot, setActiveSnapshot] = useState<Snapshot | null>(null);
  const [selectedIds, setSelectedIds]       = useState<string[]>([]);
  const [loadingSnap, setLoadingSnap]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);

  // Diff state
  const [diffBaseId, setDiffBaseId]   = useState<string | null>(null);
  const [diffResult, setDiffResult]   = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const handle   = repo.ownerHandle ?? user.handle;
  const repoName = repo.name;

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
        if (!cancelled) { setActiveSnapshot(snap); setSelectedIds([]); }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed"); })
      .finally(() => { if (!cancelled) setLoadingSnap(false); });

    return () => { cancelled = true; };
  }, [token, handle, repoName]);

  async function loadSnapshot(id: string, runDiffAgainst?: string | null) {
    setLoadingSnap(true);
    setError(null);
    if (!runDiffAgainst) setDiffResult(null);
    try {
      const snap = await getSnapshot(token, handle, repoName, id);
      setActiveSnapshot(snap);
      setSelectedIds([]);
      if (runDiffAgainst && runDiffAgainst !== id) {
        setDiffLoading(true);
        try {
          const diff = await compareDiff(token, handle, repoName, runDiffAgainst, id);
          setDiffResult(diff);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Diff failed");
        } finally {
          setDiffLoading(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load snapshot");
    } finally {
      setLoadingSnap(false);
    }
  }

  function handleSnapshotClick(id: string) {
    if (diffBaseId) {
      if (diffBaseId === id) {
        // Clicked the base again — exit compare mode
        setDiffBaseId(null);
        setDiffResult(null);
        loadSnapshot(id);
      } else {
        loadSnapshot(id, diffBaseId);
      }
    } else {
      loadSnapshot(id);
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

  const baseSummary = diffBaseId ? snapshots.find((s) => s.id === diffBaseId) : null;
  const headSummary = diffResult ? snapshots.find((s) => s.id === diffResult.targetSnapshotId) : null;

  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <button onClick={onBack} style={styles.backBtn}>← Repos</button>
        <span style={styles.repoTitle}>{repo.fullName ?? repo.name}</span>
        <span style={styles.visibility}>{repo.visibility}</span>
        {diffBaseId && <span style={styles.compareModePill}>Compare mode</span>}
        <span style={styles.statePill}>View mode</span>
      </header>

      <div style={styles.body}>
        {/* ── Left sidebar ── */}
        <aside style={styles.sidebar}>

          {/* Snapshots */}
          <div style={styles.sideSection}>
            <div style={styles.sideSectionHeader}>
              <span>Snapshots</span>
              {diffBaseId
                ? <button style={styles.exitCompareBtn} onClick={() => { setDiffBaseId(null); setDiffResult(null); }}>✕ Exit compare</button>
                : <span style={styles.readonlyBadge}>Read-only</span>
              }
            </div>
            {diffBaseId && <p style={styles.compareHint}>Click a snapshot to compare against base</p>}
            {snapshots.length === 0 && <p style={styles.muted}>No snapshots available.</p>}
            {snapshots.map((s) => {
              const isActive = activeSnapshot?.id === s.id;
              const isBase   = diffBaseId === s.id;
              return (
                <div
                  key={s.id}
                  style={{
                    ...styles.snapItem,
                    ...(isBase              ? styles.snapItemBase   : {}),
                    ...(isActive && !isBase ? styles.snapItemActive : {}),
                  }}
                >
                  <button style={styles.snapBtn} onClick={() => handleSnapshotClick(s.id)}>
                    <span style={styles.snapFile}>{s.label ?? s.sourceFile}</span>
                    <span style={styles.snapDate}>{new Date(s.createdAt).toLocaleDateString()}</span>
                  </button>
                  {isBase && <span style={styles.basePill}>BASE</span>}
                  {!diffBaseId && (
                    <button
                      title="Use as diff base"
                      style={styles.compareBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiffBaseId(s.id);
                        setDiffResult(null);
                        if (activeSnapshot && activeSnapshot.id !== s.id) {
                          loadSnapshot(activeSnapshot.id, s.id);
                        }
                      }}
                    >
                      ⟷
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Module tree */}
          {activeSnapshot && (
            <div style={{ ...styles.sideSection, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={styles.sideSectionHeader}>
                <span>Modules</span>
                <span style={styles.muted}>{activeSnapshot.entities.length} entities</span>
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

          {/* Diff summary panel */}
          {(diffResult || diffLoading) && (
            <div style={styles.diffPanel}>
              {diffLoading && <p style={{ ...styles.muted, padding: "8px 12px" }}>Computing diff…</p>}
              {diffResult && (
                <>
                  <div style={styles.sideSectionHeader}>
                    <span>Diff</span>
                    <span style={styles.muted}>
                      {baseSummary?.label ?? baseSummary?.sourceFile ?? "base"}
                      {" → "}
                      {headSummary?.label ?? headSummary?.sourceFile ?? "head"}
                    </span>
                  </div>
                  <div style={styles.diffCounts}>
                    {diffResult.summary.added    > 0 && <span style={diffCountStyle(DIFF_COLOR.added)}>+{diffResult.summary.added}</span>}
                    {diffResult.summary.removed  > 0 && <span style={diffCountStyle(DIFF_COLOR.removed)}>−{diffResult.summary.removed}</span>}
                    {diffResult.summary.modified > 0 && <span style={diffCountStyle(DIFF_COLOR.modified)}>~{diffResult.summary.modified}</span>}
                    {diffResult.summary.moved    > 0 && <span style={diffCountStyle(DIFF_COLOR.moved)}>↔{diffResult.summary.moved}</span>}
                    {diffResult.summary.unchanged > 0 && <span style={diffCountStyle(DIFF_COLOR.unchanged)}>{diffResult.summary.unchanged} same</span>}
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
                </>
              )}
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

        {/* ── Right inspector ── */}
        <aside style={styles.rightPanel}>
          {selectedDiffChange ? (
            <DiffInspector change={selectedDiffChange} />
          ) : selectedEntity ? (
            <ParameterInspector entity={selectedEntity} />
          ) : (
            <div style={styles.rightPlaceholder}>
              Click a module in the viewport or tree to inspect its parameters.
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
      {change.type === "added"   && <p style={{ fontSize: 12, color }}>New entity in this snapshot.</p>}
      {change.type === "removed" && <p style={{ fontSize: 12, color }}>Removed from this snapshot.</p>}
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
    fontSize: 12, fontWeight: 700, color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 4, padding: "1px 6px",
  };
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell:   { display: "flex", flexDirection: "column", height: "100vh", backgroundColor: "#f9fafb" },
  topbar:  { display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", backgroundColor: "#fff", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  backBtn: { fontSize: 13, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  repoTitle:  { fontSize: 15, fontWeight: 600, color: "#111827" },
  visibility: { fontSize: 11, color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 10, padding: "1px 8px" },
  statePill:       { marginLeft: "auto", fontSize: 11, color: "#475569", border: "1px solid #cbd5e1", borderRadius: 10, padding: "1px 8px", backgroundColor: "#f8fafc" },
  compareModePill: { fontSize: 11, color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 10, padding: "1px 8px", backgroundColor: "#eff6ff" },
  body:    { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: { width: 280, borderRight: "1px solid #e5e7eb", backgroundColor: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" },
  sideSection:       { borderBottom: "1px solid #f3f4f6", padding: "10px 0" },
  sideSectionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px 6px", fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" },
  readonlyBadge: { fontSize: 10, color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 10, padding: "1px 8px", backgroundColor: "#f8fafc" },
  muted:    { fontSize: 12, color: "#9ca3af", margin: 0 },
  snapItem:       { display: "flex", alignItems: "center" },
  snapItemActive: { backgroundColor: "#f0f9ff" },
  snapItemBase:   { backgroundColor: "#fef3c7" },
  snapBtn:  { display: "flex", flexDirection: "column", alignItems: "flex-start", flex: 1, padding: "6px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left" },
  snapFile: { fontSize: 13, color: "#111827", fontWeight: 500 },
  snapDate: { fontSize: 11, color: "#9ca3af", marginTop: 1 },
  basePill:     { fontSize: 10, fontWeight: 700, color: "#92400e", background: "#fde68a", borderRadius: 4, padding: "1px 6px", marginRight: 8, flexShrink: 0 },
  compareBtn:   { fontSize: 13, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", padding: "4px 8px", flexShrink: 0 },
  exitCompareBtn: { fontSize: 10, color: "#ef4444", background: "none", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 6px", cursor: "pointer" },
  compareHint: { fontSize: 11, color: "#3b82f6", padding: "2px 12px 6px", margin: 0 },
  diffPanel:      { borderTop: "1px solid #f3f4f6", padding: "8px 0", overflowY: "auto", maxHeight: 320 },
  diffCounts:     { display: "flex", gap: 6, flexWrap: "wrap", padding: "4px 12px 8px" },
  diffChangeList: { display: "flex", flexDirection: "column" },
  diffChangeRow:         { display: "flex", alignItems: "center", gap: 6, padding: "3px 12px", cursor: "pointer" },
  diffChangeRowSelected: { backgroundColor: "#eff6ff" },
  diffChangeName: { fontSize: 12, color: "#111827", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  diffChangeKind: { fontSize: 10, color: "#9ca3af", flexShrink: 0 },
  viewport: { flex: 1, overflow: "hidden", position: "relative" },
  rightPanel: { width: 320, borderLeft: "1px solid #e5e7eb", backgroundColor: "#fff", overflowY: "auto" },
  rightPlaceholder: { fontSize: 12, color: "#9ca3af", padding: "12px" },
  paramTitle: { margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#111827" },
  paramList:  { display: "grid", gap: 8 },
  paramRow:   { display: "grid", gap: 2, paddingBottom: 6, borderBottom: "1px solid #f1f5f9" },
  paramKey:   { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" },
  paramValue: { fontSize: 12, color: "#0f172a", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0, borderTop: "1px solid #fee2e2", backgroundColor: "#fff1f2" },
  viewportPlaceholder: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#9ca3af" },
  viewportIcon: { fontSize: 64, display: "block", marginBottom: 12 },
  viewportText: { fontSize: 18, fontWeight: 600, color: "#6b7280", margin: 0 },
  viewportSub:  { fontSize: 13, color: "#9ca3af", marginTop: 6 },
};
