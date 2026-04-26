import { useEffect, useState } from "react";
import {
  getSnapshot,
  getSnapshots,
} from "../api";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import type { Entity, Repo, Snapshot, SnapshotSummary, User } from "../types";

type Props = {
  token: string;
  user: User;
  repo: Repo;
  onBack: () => void;
};

export function SnapshotPage({ token, user, repo, onBack }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<Snapshot | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = repo.ownerHandle ?? user.handle;
  const repoName = repo.name;

  useEffect(() => {
    getSnapshots(token, handle, repoName)
      .then((r) => setSnapshots(r.snapshots))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [token, handle, repoName]);

  async function loadSnapshot(id: string) {
    setLoadingSnap(true);
    setSelectedIds([]);
    setError(null);
    try {
      const snap = await getSnapshot(token, handle, repoName, id);
      setActiveSnapshot(snap);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load snapshot");
    } finally {
      setLoadingSnap(false);
    }
  }

  function toggleSelect(id: string, additive: boolean) {
    if (!activeSnapshot) {
      setSelectedIds([id]);
      return;
    }

    const subtreeIds = collectSubtreeIds(id, activeSnapshot.entities);
    const subtreeSet = new Set(subtreeIds);

    setSelectedIds((prev) => {
      if (!additive) {
        return subtreeIds;
      }

      const hasAll = subtreeIds.every((sid) => prev.includes(sid));
      if (hasAll) {
        return prev.filter((sid) => !subtreeSet.has(sid));
      }

      const merged = new Set(prev);
      for (const sid of subtreeIds) {
        merged.add(sid);
      }
      return [...merged];
    });
  }

  const entityById = (id: string): Entity | undefined =>
    activeSnapshot?.entities.find((e) => e.id === id);

  function collectSubtreeIds(rootDbId: string, entities: Entity[]): string[] {
    const root = entities.find((e) => e.id === rootDbId);
    if (!root) return [rootDbId];
    const ids = new Set<string>([rootDbId]);
    const queue = [root.entityId];
    while (queue.length) {
      const parentEntityId = queue.shift()!;
      for (const e of entities) {
        if (e.parentEntityId === parentEntityId && !ids.has(e.id)) {
          ids.add(e.id);
          queue.push(e.entityId);
        }
      }
    }
    return [...ids];
  }

  return (
    <div style={styles.shell}>
      {/* top bar */}
      <header style={styles.topbar}>
        <button onClick={onBack} style={styles.backBtn}>← Repos</button>
        <span style={styles.repoTitle}>{repo.fullName ?? repo.name}</span>
        <span style={styles.visibility}>{repo.visibility}</span>
      </header>

      <div style={styles.body}>
        {/* LEFT PANEL */}
        <aside style={styles.sidebar}>
          {/* snapshot selector */}
          <div style={styles.sideSection}>
            <div style={styles.sideSectionHeader}>
              <span>Snapshots</span>
              <span style={styles.readonlyBadge}>Read-only</span>
            </div>
            {snapshots.length === 0 && (
              <p style={styles.muted}>No snapshots available.</p>
            )}
            {snapshots.map((s) => (
              <div
                key={s.id}
                style={{
                  ...styles.snapItem,
                  ...(activeSnapshot?.id === s.id ? styles.snapItemActive : {}),
                }}
              >
                <button
                  style={styles.snapBtn}
                  onClick={() => loadSnapshot(s.id)}
                >
                  <span style={styles.snapFile}>{s.label ?? s.sourceFile}</span>
                  <span style={styles.snapDate}>
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </button>
              </div>
            ))}
          </div>

          {/* module tree */}
          {activeSnapshot && (
            <div style={{ ...styles.sideSection, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={styles.sideSectionHeader}>
                <span>Modules</span>
                <span style={styles.muted}>{activeSnapshot.entities.length} entities</span>
              </div>
              {loadingSnap ? (
                <p style={styles.muted}>Loading...</p>
              ) : (
                <div style={{ overflowY: "auto", flex: 1 }}>
                  <ModuleTree
                    entities={activeSnapshot.entities}
                    constraints={activeSnapshot.constraints}
                    selectedIds={selectedIds}
                    onSelect={toggleSelect}
                  />
                </div>
              )}
            </div>
          )}

          {error && <p style={styles.errorMsg}>{error}</p>}
        </aside>

        {/* MAIN AREA — 3D viewer */}
        <main style={styles.viewport}>
          {activeSnapshot ? (
            <Viewport
              entities={activeSnapshot.entities}
              constraints={activeSnapshot.constraints}
              selectedIds={selectedIds}
              onSelect={toggleSelect}
            />
          ) : (
            <div style={styles.viewportPlaceholder}>
              <span style={styles.viewportIcon}>⬡</span>
              <p style={styles.viewportText}>3D Viewport</p>
              <p style={styles.viewportSub}>Select a snapshot to view its assembly</p>
            </div>
          )}
        </main>

        {/* RIGHT PANEL */}
        <aside style={styles.rightPanel}>
          {selectedIds.length > 0 && activeSnapshot ? (
            <div style={styles.inspectPanel}>
              <div style={styles.sideSectionHeader}>Inspect</div>
              <p style={styles.inspectTitle}>
                <b>{selectedIds.length === 1 ? entityById(selectedIds[0]!)?.name ?? "Unknown" : `${selectedIds.length} selected`}</b>
              </p>
              <p style={styles.inspectText}>
                This viewer is read-only. Editing tools are disabled.
              </p>
              {selectedIds.length === 1 && (
                <div style={styles.inspectMeta}>
                  <div><span style={styles.metaLabel}>Kind:</span> {entityById(selectedIds[0]!)?.kind ?? "-"}</div>
                  <div><span style={styles.metaLabel}>Path:</span> {entityById(selectedIds[0]!)?.path ?? "-"}</div>
                </div>
              )}
            </div>
          ) : (
            <div style={styles.rightPanelPlaceholder}>
              Select module(s) to inspect details.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { display: "flex", flexDirection: "column", height: "100vh", backgroundColor: "#f9fafb" },
  topbar: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 20px", backgroundColor: "#fff",
    borderBottom: "1px solid #e5e7eb", flexShrink: 0,
  },
  backBtn: {
    fontSize: 13, color: "#6b7280", background: "none",
    border: "1px solid #e5e7eb", borderRadius: 6,
    padding: "4px 10px", cursor: "pointer",
  },
  repoTitle: { fontSize: 15, fontWeight: 600, color: "#111827" },
  visibility: {
    fontSize: 11, color: "#6b7280", border: "1px solid #e5e7eb",
    borderRadius: 10, padding: "1px 8px",
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: 280, borderRight: "1px solid #e5e7eb", backgroundColor: "#fff",
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  sideSection: { borderBottom: "1px solid #f3f4f6", padding: "10px 0" },
  sideSectionHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 12px 6px", fontSize: 11, fontWeight: 600,
    color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em",
  },
  readonlyBadge: {
    fontSize: 10,
    color: "#64748b",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "1px 8px",
    backgroundColor: "#f8fafc",
  },
  muted: { fontSize: 12, color: "#9ca3af", padding: "0 12px" },
  snapItem: {
    display: "flex", alignItems: "center",
  },
  snapItemActive: { backgroundColor: "#f0f9ff" },
  snapBtn: {
    display: "flex", flexDirection: "column", alignItems: "flex-start",
    flex: 1, padding: "6px 12px", background: "none",
    border: "none", cursor: "pointer", textAlign: "left",
  },
  snapFile: { fontSize: 13, color: "#111827", fontWeight: 500 },
  snapDate: { fontSize: 11, color: "#9ca3af", marginTop: 1 },
  constraintPanel: {
    borderBottom: "1px solid #f3f4f6",
    padding: "10px 12px",
    backgroundColor: "#fefce8",
  },
  constraintPair: { fontSize: 12, color: "#374151", margin: "4px 0 8px" },
  fixHint: { fontSize: 11, color: "#6b7280", margin: "0 0 8px" },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", marginBottom: 4, cursor: "pointer" },
  stepInput: {
    width: 70,
    marginLeft: "auto",
    padding: "3px 6px",
    fontSize: 12,
    border: "1px solid #d1d5db",
    borderRadius: 4,
  },
  moveGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
    marginTop: 8,
  },
  moveBtn: {
    padding: "6px 0",
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: "#fff",
    color: "#374151",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    cursor: "pointer",
  },
  fixBtn: {
    flex: 1, padding: "6px 0", fontSize: 13, fontWeight: 600,
    backgroundColor: "#111827", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer",
  },
  cancelBtn: {
    flex: 1, padding: "6px 0", fontSize: 13,
    backgroundColor: "transparent", color: "#6b7280",
    border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer",
  },
  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0 },
  viewport: {
    flex: 1, overflow: "hidden", position: "relative",
  },
  rightPanel: {
    width: 220,
    borderLeft: "1px solid #e5e7eb",
    backgroundColor: "#fff",
    overflowY: "auto",
    flexShrink: 0,
  },
  rightPanelPlaceholder: {
    fontSize: 12,
    color: "#9ca3af",
    padding: "12px",
  },
  inspectPanel: {
    borderBottom: "1px solid #f3f4f6",
    padding: "10px 12px",
    backgroundColor: "#f8fafc",
  },
  inspectTitle: { fontSize: 12, color: "#111827", margin: "4px 0 8px" },
  inspectText: { fontSize: 12, color: "#475569", margin: "0 0 8px" },
  inspectMeta: { fontSize: 12, color: "#334155", display: "grid", gap: 4 },
  metaLabel: { color: "#64748b", fontWeight: 600 },
  viewportPlaceholder: { textAlign: "center", color: "#9ca3af" },
  viewportIcon: { fontSize: 64, display: "block", marginBottom: 12 },
  viewportText: { fontSize: 18, fontWeight: 600, color: "#6b7280", margin: 0 },
  viewportSub: { fontSize: 13, color: "#9ca3af", marginTop: 6 },
};
