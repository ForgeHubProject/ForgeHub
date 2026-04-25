import { useEffect, useRef, useState } from "react";
import {
  createConstraint,
  deleteConstraint,
  getSnapshot,
  getSnapshots,
  ingestSnapshot,
} from "../api";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import type { Constraint, Entity, Repo, Snapshot, SnapshotSummary, User } from "../types";

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
  const [posFixed, setPosFixed] = useState(true);
  const [rotFixed, setRotFixed] = useState(true);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function uploadGltf(file: File) {
    setUploading(true);
    setError(null);
    try {
      const text = await file.text();
      const gltf = JSON.parse(text) as unknown;
      const snap = await ingestSnapshot(token, handle, repoName, gltf, undefined, file.name);
      setSnapshots((prev) => [snap, ...prev]);
      setActiveSnapshot(snap);
      setSelectedIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  }

  async function fixSelected() {
    if (!activeSnapshot || selectedIds.length !== 2) return;
    setError(null);
    try {
      const c = await createConstraint(
        token, handle, repoName, activeSnapshot.id,
        selectedIds[0]!, selectedIds[1]!, posFixed, rotFixed,
      );
      setActiveSnapshot((prev) =>
        prev ? { ...prev, constraints: [...prev.constraints, c] } : prev,
      );
      setSelectedIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create constraint");
    }
  }

  async function unfix(constraintId: string) {
    if (!activeSnapshot) return;
    setError(null);
    try {
      await deleteConstraint(token, handle, repoName, activeSnapshot.id, constraintId);
      setActiveSnapshot((prev) =>
        prev
          ? { ...prev, constraints: prev.constraints.filter((c) => c.id !== constraintId) }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove constraint");
    }
  }

  const entityById = (id: string): Entity | undefined =>
    activeSnapshot?.entities.find((e) => e.id === id);

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
              <button
                onClick={() => fileRef.current?.click()}
                style={styles.uploadBtn}
                disabled={uploading}
                title="Upload .gltf file"
              >
                {uploading ? "..." : "+ Upload"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".gltf,application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadGltf(f);
                  e.target.value = "";
                }}
              />
            </div>
            {snapshots.length === 0 && (
              <p style={styles.muted}>No snapshots yet. Upload a .gltf file.</p>
            )}
            {snapshots.map((s) => (
              <button
                key={s.id}
                style={{
                  ...styles.snapBtn,
                  ...(activeSnapshot?.id === s.id ? styles.snapBtnActive : {}),
                }}
                onClick={() => loadSnapshot(s.id)}
              >
                <span style={styles.snapFile}>{s.label ?? s.sourceFile}</span>
                <span style={styles.snapDate}>
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </button>
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

          {/* constraint panel — shown when 2 entities selected */}
          {selectedIds.length === 2 && activeSnapshot && (
            <div style={styles.constraintPanel}>
              <div style={styles.sideSectionHeader}>Fix selected</div>
              <p style={styles.constraintPair}>
                <b>{entityById(selectedIds[0]!)?.name ?? "?"}</b>
                {" ↔ "}
                <b>{entityById(selectedIds[1]!)?.name ?? "?"}</b>
              </p>
              <label style={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={posFixed}
                  onChange={(e) => setPosFixed(e.target.checked)}
                />
                Position fixed
              </label>
              <label style={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={rotFixed}
                  onChange={(e) => setRotFixed(e.target.checked)}
                />
                Rotation fixed
              </label>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button onClick={fixSelected} style={styles.fixBtn}>Fix</button>
                <button onClick={() => setSelectedIds([])} style={styles.cancelBtn}>Cancel</button>
              </div>
            </div>
          )}

          {/* constraints list */}
          {activeSnapshot && activeSnapshot.constraints.length > 0 && (
            <div style={styles.sideSection}>
              <div style={styles.sideSectionHeader}>Constraints</div>
              {activeSnapshot.constraints.map((c: Constraint) => {
                const a = entityById(c.entityAId);
                const b = entityById(c.entityBId);
                return (
                  <div key={c.id} style={styles.constraintRow}>
                    <div style={styles.constraintNames}>
                      <span>{a?.name ?? "?"}</span>
                      <span style={{ color: "#9ca3af" }}>↔</span>
                      <span>{b?.name ?? "?"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {c.positionFixed && <span style={badge("#3b82f6")}>P</span>}
                      {c.rotationFixed && <span style={badge("#8b5cf6")}>R</span>}
                      <button onClick={() => unfix(c.id)} style={styles.unfixBtn} title="Remove constraint">✕</button>
                    </div>
                  </div>
                );
              })}
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
      </div>
    </div>
  );
}

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 9, fontWeight: 700, color: "#fff", backgroundColor: color,
    borderRadius: 3, padding: "1px 4px", lineHeight: 1.5,
  };
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
  uploadBtn: {
    fontSize: 11, color: "#3b82f6", background: "none",
    border: "1px solid #bfdbfe", borderRadius: 4,
    padding: "2px 8px", cursor: "pointer",
  },
  muted: { fontSize: 12, color: "#9ca3af", padding: "0 12px" },
  snapBtn: {
    display: "flex", flexDirection: "column", alignItems: "flex-start",
    width: "100%", padding: "6px 12px", background: "none",
    border: "none", cursor: "pointer", textAlign: "left",
  },
  snapBtnActive: { backgroundColor: "#f0f9ff" },
  snapFile: { fontSize: 13, color: "#111827", fontWeight: 500 },
  snapDate: { fontSize: 11, color: "#9ca3af", marginTop: 1 },
  constraintPanel: {
    borderBottom: "1px solid #f3f4f6",
    padding: "10px 12px",
    backgroundColor: "#fefce8",
  },
  constraintPair: { fontSize: 12, color: "#374151", margin: "4px 0 8px" },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", marginBottom: 4, cursor: "pointer" },
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
  constraintRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "5px 12px",
  },
  constraintNames: { display: "flex", gap: 4, fontSize: 12, color: "#374151", alignItems: "center" },
  unfixBtn: {
    fontSize: 11, color: "#ef4444", background: "none",
    border: "none", cursor: "pointer", padding: "2px 4px",
  },
  errorMsg: { fontSize: 12, color: "#ef4444", padding: "8px 12px", margin: 0 },
  viewport: {
    flex: 1, overflow: "hidden", position: "relative",
  },
  viewportPlaceholder: { textAlign: "center", color: "#9ca3af" },
  viewportIcon: { fontSize: 64, display: "block", marginBottom: 12 },
  viewportText: { fontSize: 18, fontWeight: 600, color: "#6b7280", margin: 0 },
  viewportSub: { fontSize: 13, color: "#9ca3af", marginTop: 6 },
};
