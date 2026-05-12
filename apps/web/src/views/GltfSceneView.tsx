import type { CSSProperties } from "react";
import { useMemo } from "react";
import { ModuleTree } from "../components/ModuleTree";
import { Viewport } from "../components/Viewport";
import type { DiffChange, Entity } from "../types";
import { gltfSceneWorkspaceStyles as styles } from "./gltfSceneWorkspace.styles";
import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";

const DIFF_COLOR: Record<string, string> = {
  added: "#22c55e",
  removed: "#ef4444",
  modified: "#f59e0b",
  moved: "#f97316",
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
  visibleCommits,
  activeCommitId,
  handleModuleClick,
  loadCommit,
}: RepoCodeWorkspaceProps) {
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
    if (!diffResult) return null;
    if (ghostSelectedId) return diffResult.changes.find((c) => c.entityId === ghostSelectedId) ?? null;
    if (selectedEntity) return diffResult.changes.find((c) => c.entityId === selectedEntity.entityId) ?? null;
    return null;
  }, [diffResult, ghostSelectedId, selectedEntity]);

  return (
    <>
      <aside style={styles.sidebar}>
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
            diffChanges={diffResult?.changes ?? null}
            diffMode={diffMode}
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

        {activeSnapshot && diffResult && (
          <button style={styles.diffToggle} onClick={() => setDiffMode((d) => !d)}>
            {diffMode ? "◑ Diff" : "◐ Normal"}
          </button>
        )}

        {diffMode && diffResult && activeSnapshot && (
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
          {visibleCommits.length === 0 && <p style={{ ...styles.muted, padding: "6px 12px" }}>No commits yet.</p>}
          {visibleCommits.map((c, i) => {
            const isActive = activeCommitId === c.id;
            const hasDiff = isActive && diffResult;
            const isLast = i === visibleCommits.length - 1;
            const mod = modules.find((m) => m.sourceFile === c.sourceFile);
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
                    {c.gitCommitSha && <span style={styles.commitSha}>{c.gitCommitSha.slice(0, 7)}</span>}
                  </div>
                  {hasDiff && diffResult && (
                    <div style={styles.commitDiffBadges}>
                      {diffResult.summary.added > 0 && (
                        <span style={diffBadgeStyle("#22c55e")}>+{diffResult.summary.added}</span>
                      )}
                      {diffResult.summary.removed > 0 && (
                        <span style={diffBadgeStyle("#ef4444")}>−{diffResult.summary.removed}</span>
                      )}
                      {diffResult.summary.modified > 0 && (
                        <span style={diffBadgeStyle("#f59e0b")}>~{diffResult.summary.modified}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {selectedEntity || ghostSelectedId ? (
          <EntityInspector entity={selectedEntity ?? null} change={selectedChange} diffMode={diffMode} />
        ) : (
          <div style={styles.rightPlaceholder}>Click a commit to explore its diff, or select an entity in the viewport.</div>
        )}
      </aside>
    </>
  );
}

type PropKind = "normal" | "changed" | "added" | "removed";
type PropRow = { label: string; value: string; kind: PropKind; before?: string };

function EntityInspector({
  entity,
  change,
  diffMode,
}: {
  entity: Entity | null;
  change: DiffChange | null;
  diffMode: boolean;
}) {
  const type = change?.type;
  const isRemoved = type === "removed";
  const isAdded = type === "added";
  const isModified = type === "modified" || type === "moved";

  const src = entity
    ? { name: entity.name, kind: entity.kind, path: entity.path, transform: entity.transform, attributes: entity.attributes }
    : isRemoved
      ? change!.before
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
    push("scale", src.transform.scale, "scale");
  }

  const attrFc = getfc("attributes");
  const curAttrs = src.attributes ?? {};
  const prevAttrs = (attrFc?.before ?? {}) as Record<string, unknown>;
  const nextAttrs = (attrFc?.after ?? {}) as Record<string, unknown>;
  const allAttrKeys = new Set([...Object.keys(curAttrs), ...Object.keys(prevAttrs)]);

  for (const key of allAttrKeys) {
    const inPrev = key in prevAttrs;
    const inNext = key in nextAttrs;
    if (diffMode && attrFc && inPrev && !inNext) {
      rows.push({ label: key, value: fmtVal(prevAttrs[key]), kind: "removed" });
    } else {
      const val = curAttrs[key] ?? prevAttrs[key];
      let kind: PropKind = globalKind;
      let before: string | undefined;
      if (diffMode && attrFc) {
        if (!inPrev && inNext) kind = "added";
        else if (JSON.stringify(prevAttrs[key]) !== JSON.stringify(nextAttrs[key])) {
          kind = "changed";
          before = fmtVal(prevAttrs[key]);
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
