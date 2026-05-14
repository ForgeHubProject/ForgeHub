import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import { commitGroupFileChipLabel } from "../lib/commitGroups";
import type { DiffChange, DiffChangeType, DiffEntitySnapshot, Entity } from "../types";
import { isGlTfDiff } from "../types";
import { gltfSceneWorkspaceStyles as styles } from "./gltfSceneWorkspace.styles";
import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";

const DIFF_COLOR: Record<string, string> = {
  added: "#22c55e",
  removed: "#ef4444",
  modified: "#64748b",
  moved: "#6366f1",
  unchanged: "#94a3b8",
};

const DIFF_ICON: Record<string, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  moved: "↔",
};

export function GltfSceneView({
  loadingSnap,
  diffLoading,
  modules,
  selectedModuleFile,
  setSelectedModuleFile,
  activeSnapshot,
  selectionPath,
  setSelectionPath,
  diffResult,
  diffMode,
  setDiffMode,
  ghostSelectedId,
  setGhostSelectedId,
  commitGroups,
  expandedCommitKey,
  commitFilePreviews,
  commitChangedFileCountByKey,
  commitChangedFileCountLoadingByKey,
  changedCommitKeysForSelectedFile,
  changedCommitKeysForSelectedFileLoading,
  onCommitGroupToggle,
  onPickSnapshotFromCommit,
  activeCommitId,
  handleModuleClick,
}: RepoCodeWorkspaceProps) {
  const [diffOverlayMode, setDiffOverlayMode] = useState<"old" | "both" | "new">("both");
  function buildParentMap(entities: Entity[]): Map<string, string | null> {
    const entityIdToDbId = new Map<string, string>();
    for (const e of entities) entityIdToDbId.set(e.entityId, e.id);
    const m = new Map<string, string | null>();
    for (const e of entities) {
      m.set(e.id, e.parentEntityId ? (entityIdToDbId.get(e.parentEntityId) ?? null) : null);
    }
    return m;
  }

  function getAncestorChain(id: string, parentMap: Map<string, string | null>): string[] {
    const chain: string[] = [];
    let cur: string | null = id;
    while (cur !== null) {
      chain.unshift(cur);
      cur = parentMap.get(cur) ?? null;
    }
    return chain;
  }

  function handleDrillSelect(clickedId: string) {
    if (!activeSnapshot) return;
    setGhostSelectedId(null);
    const parentMap = buildParentMap(activeSnapshot.entities);
    const chain = getAncestorChain(clickedId, parentMap);

    if (selectionPath.length === 0) {
      setSelectionPath([chain[0]]);
      return;
    }

    const focusId = selectionPath[selectionPath.length - 1];
    if (focusId === clickedId) return;

    const focusIdx = chain.indexOf(focusId);
    if (focusIdx !== -1) {
      const nextId = chain[focusIdx + 1];
      if (nextId) setSelectionPath([...selectionPath, nextId]);
    } else {
      setSelectionPath([chain[0]]);
    }
  }

  function handleTreeSelect(id: string) {
    if (!activeSnapshot) return;
    setGhostSelectedId(null);
    const parentMap = buildParentMap(activeSnapshot.entities);
    setSelectionPath(getAncestorChain(id, parentMap));
  }

  const selectedEntity =
    activeSnapshot?.entities.find((e) => e.id === selectionPath[selectionPath.length - 1]) ?? null;

  const selectedChange = useMemo(() => {
    if (!diffResult || !isGlTfDiff(diffResult)) return null;
    if (ghostSelectedId) return diffResult.changes.find((c) => c.entityId === ghostSelectedId) ?? null;
    if (selectedEntity) return diffResult.changes.find((c) => c.entityId === selectedEntity.entityId) ?? null;
    return null;
  }, [diffResult, ghostSelectedId, selectedEntity]);

  const diffEntityTypeMap = useMemo(() => {
    if (!diffMode || !diffResult || !isGlTfDiff(diffResult)) return null;
    const m = new Map<string, DiffChangeType>();
    for (const c of diffResult.changes) {
      if (c.type !== "unchanged") m.set(c.entityId, c.type);
    }
    return m;
  }, [diffMode, diffResult]);

  const { diffSceneHasOld, diffSceneHasNew } = useMemo(() => {
    if (!diffResult || !isGlTfDiff(diffResult)) return { diffSceneHasOld: false, diffSceneHasNew: false };
    let diffSceneHasOld = false;
    let diffSceneHasNew = false;
    for (const c of diffResult.changes) {
      if (c.type === "unchanged") continue;
      if (c.type === "removed") diffSceneHasOld = true;
      if (c.type === "added" && c.after?.transform) diffSceneHasNew = true;
      if (c.type === "modified" || c.type === "moved") {
        if (c.before?.transform) diffSceneHasOld = true;
        if (c.after?.transform) diffSceneHasNew = true;
      }
    }
    return { diffSceneHasOld, diffSceneHasNew };
  }, [diffResult]);

  useEffect(() => {
    setDiffOverlayMode("both");
  }, [diffResult?.targetSnapshotId, diffResult?.baseSnapshotId]);

  useEffect(() => {
    if (!diffMode) setDiffOverlayMode("both");
  }, [diffMode]);

  return (
    <>
      <aside style={styles.sidebar}>
        <div style={styles.sideSection}>
          <div style={styles.sideSectionHeader}>
            <span>Files</span>
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
                selectedIds={selectionPath}
                onSelect={(id) => handleTreeSelect(id)}
                diffTypeByEntityId={diffEntityTypeMap}
              />
            </div>
          </div>
        )}
      </aside>

      <main style={styles.viewport}>
        {loadingSnap ? (
          <div style={styles.viewportPlaceholder}>
            <p style={styles.viewportText}>Loading model…</p>
          </div>
        ) : activeSnapshot ? (
          <Viewport
            entities={activeSnapshot.entities}
            constraints={activeSnapshot.constraints}
            selectionPath={selectionPath}
            onSelect={handleDrillSelect}
            onDirectSelect={handleTreeSelect}
            onDeselect={() => {
              setSelectionPath([]);
              setGhostSelectedId(null);
            }}
            diffChanges={isGlTfDiff(diffResult) ? diffResult.changes : null}
            diffMode={diffMode}
            diffOverlayMode={diffOverlayMode}
            onSelectGhost={(eid) => {
              setGhostSelectedId(eid);
              setSelectionPath([]);
            }}
          />
        ) : (
          <div style={styles.viewportPlaceholder}>
            <span style={styles.viewportIcon}>⬡</span>
            <p style={styles.viewportText}>No model to display</p>
            <p style={styles.viewportSub}>Import snapshots from your pipeline, then open this repo.</p>
          </div>
        )}

        {activeSnapshot && diffResult && isGlTfDiff(diffResult) && (
          <button style={styles.diffToggle} onClick={() => setDiffMode((d) => !d)}>
            {diffMode ? "◑ Diff" : "◐ Normal"}
          </button>
        )}

        {diffMode && diffResult && isGlTfDiff(diffResult) && (
          <div style={styles.diffViewSegment} role="group" aria-label="Diff view mode">
            {(["old", "both", "new"] as const).map((m) => (
              <button
                key={m}
                type="button"
                style={{
                  ...styles.diffViewBtn,
                  ...(diffOverlayMode === m ? styles.diffViewBtnActive : {}),
                  opacity: m === "old" && !diffSceneHasOld ? 0.35 : m === "new" && !diffSceneHasNew ? 0.35 : 1,
                }}
                disabled={(m === "old" && !diffSceneHasOld) || (m === "new" && !diffSceneHasNew)}
                onClick={() => setDiffOverlayMode(m)}
              >
                {m === "old" ? "Old" : m === "both" ? "Both" : "New"}
              </button>
            ))}
          </div>
        )}

        {diffMode && diffResult && activeSnapshot && isGlTfDiff(diffResult) && (
          <div style={styles.changesOverlay}>
            <div style={styles.overlayHeader}>
              <span>Changes</span>
              <div style={{ display: "flex", gap: 3 }}>
                {diffResult.summary.added > 0 && (
                  <span style={diffCountStyle(DIFF_COLOR.added)}>+{diffResult.summary.added}</span>
                )}
                {diffResult.summary.removed > 0 && (
                  <span style={diffCountStyle(DIFF_COLOR.removed)}>−{diffResult.summary.removed}</span>
                )}
                {diffResult.summary.modified > 0 && (
                  <span style={diffCountStyle(DIFF_COLOR.modified)}>~{diffResult.summary.modified}</span>
                )}
                {diffResult.summary.moved > 0 && (
                  <span style={diffCountStyle(DIFF_COLOR.moved)}>↔{diffResult.summary.moved}</span>
                )}
              </div>
            </div>
            {diffResult.changes
              .filter((c) => c.type !== "unchanged")
              .map((c) => {
                const isSelected = ghostSelectedId === c.entityId || selectedEntity?.entityId === c.entityId;
                return (
                  <div
                    key={c.entityId}
                    style={{ ...styles.overlayRow, ...(isSelected ? styles.overlayRowSelected : {}) }}
                    onClick={() => {
                      if (c.type === "removed") {
                        setGhostSelectedId(c.entityId);
                        setSelectionPath([]);
                      } else {
                        const match = activeSnapshot.entities.find((e) => e.entityId === c.entityId);
                        if (match) {
                          handleTreeSelect(match.id);
                          setGhostSelectedId(null);
                        }
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

      <aside style={styles.rightPanel}>
        <div style={styles.commitsSection}>
          <div style={styles.sideSectionHeader}>
            <span>Commits</span>
            {selectedModuleFile && (
              <span style={styles.muted}>{modules.find((m) => m.sourceFile === selectedModuleFile)?.displayName}</span>
            )}
          </div>
          {diffLoading && <p style={{ ...styles.muted, padding: "4px 12px" }}>Computing diff…</p>}
          {commitGroups.length === 0 && <p style={{ ...styles.muted, padding: "6px 12px" }}>No commits yet.</p>}
          {commitGroups.map((group, gi) => {
            const touchesChosen =
              !selectedModuleFile || group.snapshots.some((s) => s.sourceFile === selectedModuleFile);
            const selectedFileTouched = Boolean(
              selectedModuleFile && group.snapshots.some((s) => s.sourceFile === selectedModuleFile),
            );
            const selectedFileChanged = Boolean(selectedModuleFile && changedCommitKeysForSelectedFile?.[group.key]);
            const selectedFileChangeLoading = Boolean(
              selectedModuleFile && changedCommitKeysForSelectedFileLoading?.[group.key],
            );
            const isActiveGroup = group.snapshots.some((s) => s.id === activeCommitId);
            const isExpanded = expandedCommitKey === group.key;
            const isLast = gi === commitGroups.length - 1;
            const sha = group.gitCommitSha?.slice(0, 7);
            const n = group.snapshots.length;
            return (
              <div
                key={group.key}
                style={{
                  opacity: touchesChosen ? (selectedFileTouched && !selectedFileChanged ? 0.45 : 1) : 0.2,
                  borderBottom: gi < commitGroups.length - 1 ? "1px solid #f3f4f6" : undefined,
                }}
              >
                <button
                  type="button"
                  style={{
                    ...styles.commitBtn,
                    ...(isActiveGroup ? styles.commitBtnActive : {}),
                    width: "100%",
                    ...(selectedFileTouched && selectedFileChanged
                      ? { border: "1px solid #bfdbfe", background: "#eff6ff" }
                      : {}),
                  }}
                  onClick={() => {
                    void onCommitGroupToggle(group);
                  }}
                >
                  <div style={styles.commitTrack}>
                    <div style={{ ...styles.commitDot, ...(isActiveGroup ? styles.commitDotActive : {}) }} />
                    {!isLast && <div style={styles.commitLine} />}
                  </div>
                  <div style={styles.commitInfo}>
                    <span style={styles.commitMsg}>{group.label ?? group.snapshots[0]?.sourceFile ?? "Commit"}</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                      <span style={styles.commitDate}>{new Date(group.createdAt).toLocaleDateString()}</span>
                      {sha && <span style={styles.commitSha}>{sha}</span>}
                      {n > 1 && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#2563eb",
                            background: "#eff6ff",
                            borderRadius: 4,
                            padding: "1px 6px",
                          }}
                        >
                          {commitGroupFileChipLabel({
                            pathsInCommit: n,
                            commitKey: group.key,
                            isExpanded,
                            previews: isExpanded ? commitFilePreviews : null,
                            knownChangedFileCountByKey: commitChangedFileCountByKey,
                            knownChangedFileCountLoadingByKey: commitChangedFileCountLoadingByKey,
                          })}{" "}
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      )}
                      {selectedModuleFile && selectedFileTouched && selectedFileChangeLoading && (
                        <span style={{ fontSize: 10, color: "#94a3b8" }}>checking…</span>
                      )}
                    </div>
                    {n === 1 && isActiveGroup && diffResult && isGlTfDiff(diffResult) && (
                      <div style={styles.commitDiffBadges}>
                        {diffResult.summary.added > 0 && (
                          <span style={diffBadgeStyle("#22c55e")}>+{diffResult.summary.added}</span>
                        )}
                        {diffResult.summary.removed > 0 && (
                          <span style={diffBadgeStyle("#ef4444")}>−{diffResult.summary.removed}</span>
                        )}
                        {diffResult.summary.modified > 0 && (
                          <span style={diffBadgeStyle("#64748b")}>~{diffResult.summary.modified}</span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
                {isExpanded && commitFilePreviews && (
                  <div style={{ padding: "4px 8px 8px 36px", display: "flex", flexDirection: "column", gap: 4 }}>
                    {commitFilePreviews.length === 0 ? (
                      <div style={{ fontSize: 11, color: "#94a3b8", padding: "4px 2px 2px" }}>
                        No per-file changes vs the previous snapshot (other files in this commit were unchanged).
                      </div>
                    ) : null}
                    {commitFilePreviews.map((row) => {
                      const snap = group.snapshots.find((s) => s.id === row.snapshotId);
                      if (!snap) return null;
                      const fileActive = activeCommitId === row.snapshotId;
                      return (
                        <button
                          type="button"
                          key={row.snapshotId}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 4,
                            width: "100%",
                            textAlign: "left",
                            padding: "8px 10px",
                            border: "1px solid #e5e7eb",
                            borderRadius: 6,
                            background: fileActive ? "#f0f9ff" : "#fafafa",
                            cursor: "pointer",
                          }}
                          onClick={() => onPickSnapshotFromCommit(snap)}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8 }}>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#111827",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                              }}
                              title={row.sourceFile}
                            >
                              {row.sourceFile.split("/").pop()}
                            </span>
                            <span style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0 }}>{row.handlerId}</span>
                          </div>
                          {row.error && (
                            <span style={{ fontSize: 10, color: "#dc2626" }}>{row.error}</span>
                          )}
                          {!row.loading && row.stats && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              <span style={{ ...diffBadgeStyle("#22c55e"), opacity: row.stats.added > 0 ? 1 : 0.25 }}>
                                +{row.stats.added}
                              </span>
                              <span style={{ ...diffBadgeStyle("#ef4444"), opacity: row.stats.removed > 0 ? 1 : 0.25 }}>
                                −{row.stats.removed}
                              </span>
                              <span
                                style={{ ...diffBadgeStyle("#64748b"), opacity: row.stats.modified > 0 ? 1 : 0.25 }}
                              >
                                ~{row.stats.modified}
                              </span>
                              <span style={{ ...diffBadgeStyle("#6366f1"), opacity: row.stats.moved > 0 ? 1 : 0.25 }}>
                                ↔{row.stats.moved}
                              </span>
                            </div>
                          )}
                          {row.loading && <span style={{ fontSize: 10, color: "#94a3b8" }}>Diff…</span>}
                          {!row.loading && !row.stats && !row.error && (
                            <span style={{ fontSize: 10, color: "#94a3b8" }}>First version</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {selectedEntity || ghostSelectedId ? (
          <EntityInspector
            entity={selectedEntity ?? null}
            change={selectedChange}
            diffMode={diffMode}
            diffOverlayMode={diffOverlayMode}
          />
        ) : (
          <div style={styles.rightPlaceholder}>
            Each row is one Git commit. Multi-file pushes expand to list only files that changed (+/−/~); pick a file to open it.
            Select an entity in the viewport for details.
          </div>
        )}
      </aside>
    </>
  );
}

type PropKind = "normal" | "changed" | "added" | "removed";
type PropRow = { label: string; value: string; kind: PropKind; before?: string };

type DisplaySrc = {
  name: string;
  kind: string;
  path: string;
  transform: Entity["transform"];
  attributes: Record<string, unknown>;
};

function entityToSrc(e: Entity): DisplaySrc {
  return {
    name: e.name,
    kind: e.kind,
    path: e.path,
    transform: e.transform,
    attributes: e.attributes ?? {},
  };
}

function snapToSrc(s: DiffEntitySnapshot): DisplaySrc {
  return {
    name: s.name,
    kind: s.kind,
    path: s.path,
    transform: s.transform,
    attributes: s.attributes ?? {},
  };
}

function EntityInspector({
  entity,
  change,
  diffMode,
  diffOverlayMode,
}: {
  entity: Entity | null;
  change: DiffChange | null;
  diffMode: boolean;
  diffOverlayMode: "old" | "both" | "new";
}) {
  const type = change?.type;
  const isRemoved = type === "removed";
  const isAdded = type === "added";
  const isModified = type === "modified" || type === "moved";

  const showFieldDiff = Boolean(diffMode && change && diffOverlayMode === "both");

  let src: DisplaySrc | null = null;
  let emptyBanner: string | null = null;

  if (!diffMode || !change) {
    if (entity) src = entityToSrc(entity);
  } else if (diffOverlayMode === "old") {
    if (change.before) src = snapToSrc(change.before);
    else emptyBanner = "No previous version for this change.";
  } else if (diffOverlayMode === "new") {
    if (change.after) src = snapToSrc(change.after);
    else emptyBanner = "No new version for this change.";
  } else {
    if (entity) src = entityToSrc(entity);
    else if (isRemoved && change.before) src = snapToSrc(change.before);
    else emptyBanner = "No data.";
  }

  if (!src) {
    return <div style={styles.rightPlaceholder}>{emptyBanner ?? "No data."}</div>;
  }

  const globalKind: PropKind = !diffMode ? "normal" : isRemoved ? "removed" : isAdded ? "added" : "normal";
  const getfc = (field: string) => change?.fieldChanges.find((f) => f.field === field);

  const changedPropertyCount =
    change && diffMode && isModified && showFieldDiff
      ? new Set(change.fieldChanges.map((f) => f.field)).size
      : 0;

  const rows: PropRow[] = [];

  const push = (label: string, value: unknown, field?: string) => {
    const fc = showFieldDiff && field ? getfc(field) : null;
    rows.push({
      label,
      value: fmtVal(value),
      kind: !diffMode ? "normal" : fc ? "changed" : globalKind,
      before: fc && showFieldDiff ? fmtVal(fc.before) : undefined,
    });
  };

  push("name", src.name, "name");
  push("kind", src.kind);
  push("path", src.path);
  if (src.transform) {
    push("position", src.transform.position, "position");
    push("rotation", src.transform.rotationEulerDeg, "rotation");
    push("scale", src.transform.scale, "scale");
  }

  const attrFc = showFieldDiff ? getfc("attributes") : undefined;
  const curAttrs = src.attributes ?? {};
  const prevAttrs = (attrFc?.before ?? {}) as Record<string, unknown>;
  const nextAttrs = (attrFc?.after ?? {}) as Record<string, unknown>;
  const allAttrKeys = showFieldDiff
    ? new Set([...Object.keys(curAttrs), ...Object.keys(prevAttrs)])
    : new Set(Object.keys(curAttrs));

  for (const key of allAttrKeys) {
    if (showFieldDiff && attrFc) {
      const inPrev = key in prevAttrs;
      const inNext = key in nextAttrs;
      if (diffMode && inPrev && !inNext) {
        rows.push({ label: key, value: fmtVal(prevAttrs[key]), kind: "removed" });
      } else {
        const val = curAttrs[key] ?? prevAttrs[key];
        let kind: PropKind = globalKind;
        let before: string | undefined;
        if (!inPrev && inNext) kind = "added";
        else if (JSON.stringify(prevAttrs[key]) !== JSON.stringify(nextAttrs[key])) {
          kind = "changed";
          before = fmtVal(prevAttrs[key]);
        }
        rows.push({ label: key, value: fmtVal(val), kind, before });
      }
    } else {
      const val = curAttrs[key];
      if (val !== undefined) rows.push({ label: key, value: fmtVal(val), kind: "normal" });
    }
  }

  const modeLabel =
    diffMode && change ? (diffOverlayMode === "old" ? "Old" : diffOverlayMode === "new" ? "New" : "Both") : null;

  return (
    <div style={{ padding: "10px 12px", overflowY: "auto", flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis" }}>
            {src.name}
          </span>
          {modeLabel && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#64748b",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                padding: "1px 6px",
                flexShrink: 0,
              }}
            >
              {modeLabel}
            </span>
          )}
        </div>
        {change && diffMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isModified && showFieldDiff && (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontFamily: "monospace" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#ef4444" }}>-{changedPropertyCount}</span>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#22c55e" }}>+{changedPropertyCount}</span>
              </span>
            )}
            <span style={{ fontSize: 11, fontWeight: 700, color: DIFF_COLOR[type!] }}>
              {DIFF_ICON[type!]} {type}
            </span>
          </div>
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
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return (v as number[]).map((n) => n.toFixed(2)).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function propRowStyle(kind: PropKind): CSSProperties {
  const bg =
    kind === "changed" ? "#fef9c3" : kind === "added" ? "#dcfce7" : kind === "removed" ? "#fee2e2" : "transparent";
  return {
    display: "grid",
    gap: 1,
    padding: "3px 6px",
    borderRadius: 4,
    marginBottom: 3,
    backgroundColor: bg,
    borderBottom: "1px solid #f1f5f9",
  };
}

function diffCountStyle(color: string): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 4,
    padding: "1px 5px",
  };
}

function diffBadgeStyle(color: string): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 3,
    padding: "0 4px",
  };
}
