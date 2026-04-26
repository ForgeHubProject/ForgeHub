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
    let cancelled = false;
    setLoadingSnap(true);
    setError(null);

    getSnapshots(token, handle, repoName)
      .then(async (r) => {
        if (cancelled) return;
        setSnapshots(r.snapshots);
        const latest = r.snapshots[0];
        if (!latest) {
          setActiveSnapshot(null);
          return;
        }
        const snap = await getSnapshot(token, handle, repoName, latest.id);
        if (!cancelled) {
          setActiveSnapshot(snap);
          setSelectedIds([]);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      })
      .finally(() => {
        if (!cancelled) setLoadingSnap(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, handle, repoName]);

  async function loadSnapshot(id: string) {
    setLoadingSnap(true);
    setError(null);
    try {
      const snap = await getSnapshot(token, handle, repoName, id);
      setActiveSnapshot(snap);
      setSelectedIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load snapshot");
    } finally {
      setLoadingSnap(false);
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds([id]);
  }

  const selectedEntity =
    selectedIds.length === 1
      ? activeSnapshot?.entities.find((e) => e.id === selectedIds[0])
      : null;

  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <button onClick={onBack} style={styles.backBtn}>← Repos</button>
        <span style={styles.repoTitle}>{repo.fullName ?? repo.name}</span>
        <span style={styles.visibility}>{repo.visibility}</span>
        <span style={styles.statePill}>View mode</span>
      </header>

      <div style={styles.body}>
        <aside style={styles.sidebar}>
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
                  onSelect={(id) => toggleSelect(id)}
                />
              </div>
            </div>
          )}
        </aside>

        <main style={styles.viewport}>
          {loadingSnap ? (
            <div style={styles.viewportPlaceholder}>
              <p style={styles.viewportText}>Loading model...</p>
            </div>
          ) : activeSnapshot ? (
            <Viewport
              entities={activeSnapshot.entities}
              constraints={activeSnapshot.constraints}
              selectedIds={selectedIds}
              onSelect={(id) => toggleSelect(id)}
            />
          ) : (
            <div style={styles.viewportPlaceholder}>
              <span style={styles.viewportIcon}>⬡</span>
              <p style={styles.viewportText}>No model to display</p>
              <p style={styles.viewportSub}>Upload/import snapshots from your pipeline, then open this repo.</p>
            </div>
          )}
        </main>

        <aside style={styles.rightPanel}>
          {selectedEntity ? (
            <div style={styles.inspectPanel}>
              <div style={styles.sideSectionHeader}>
                <span>Parameters</span>
              </div>
              <p style={styles.paramTitle}>{selectedEntity.name}</p>
              <div style={styles.paramList}>
                {Object.entries(toParameterMap(selectedEntity)).map(([key, value]) => (
                  <div key={key} style={styles.paramRow}>
                    <span style={styles.paramKey}>{key}</span>
                    <span style={styles.paramValue}>{stringifyParam(value)}</span>
                  </div>
                ))}
              </div>
            </div>
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

function toParameterMap(entity: Entity): Record<string, unknown> {
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
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  statePill: {
    marginLeft: "auto",
    fontSize: 11,
    color: "#475569",
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    padding: "1px 8px",
    backgroundColor: "#f8fafc",
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
  viewport: {
    flex: 1, overflow: "hidden", position: "relative",
  },
  rightPanel: {
    width: 320,
    borderLeft: "1px solid #e5e7eb",
    backgroundColor: "#fff",
    overflowY: "auto",
  },
  inspectPanel: {
    padding: "10px 12px",
  },
  rightPlaceholder: {
    fontSize: 12,
    color: "#9ca3af",
    padding: "12px",
  },
  paramTitle: {
    margin: "0 0 10px",
    fontSize: 14,
    fontWeight: 600,
    color: "#111827",
  },
  paramList: {
    display: "grid",
    gap: 8,
  },
  paramRow: {
    display: "grid",
    gap: 2,
    paddingBottom: 6,
    borderBottom: "1px solid #f1f5f9",
  },
  paramKey: {
    fontSize: 11,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  paramValue: {
    fontSize: 12,
    color: "#0f172a",
    wordBreak: "break-word",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
  },
  errorMsg: {
    fontSize: 12,
    color: "#ef4444",
    padding: "8px 12px",
    margin: 0,
    borderTop: "1px solid #fee2e2",
    backgroundColor: "#fff1f2",
  },
  viewportPlaceholder: { textAlign: "center", color: "#9ca3af" },
  viewportIcon: { fontSize: 64, display: "block", marginBottom: 12 },
  viewportText: { fontSize: 18, fontWeight: 600, color: "#6b7280", margin: 0 },
  viewportSub: { fontSize: 13, color: "#9ca3af", marginTop: 6 },
};
