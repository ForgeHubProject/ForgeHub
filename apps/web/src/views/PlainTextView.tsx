import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { commitGroupFileChipLabel } from "../lib/commitGroups";
import {
  plainTextDiffHasNew,
  plainTextDiffHasOld,
  plainTextFromBase,
  plainTextFromTarget,
} from "../lib/plainTextDiffView";
import { groupPlainTextHunks, materializePlainTextMerge } from "../lib/textMergeHunks";
import { gltfSceneWorkspaceStyles as styles } from "./gltfSceneWorkspace.styles";
import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";
import { isPlainTextDiff } from "../types";

const LINE_BG = {
  added: "#dcfce7",
  removed: "#fee2e2",
  unchanged: "transparent",
};

const textPaneStyle: CSSProperties = {
  margin: 0,
  padding: 12,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const textPaneCaptionStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#64748b",
  marginBottom: 8,
  fontFamily: "system-ui, sans-serif",
};

const textDiffViewSegment: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 108,
  zIndex: 10,
  display: "flex",
  gap: 0,
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid #e5e7eb",
  background: "#f8fafc",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
};

const textDiffViewBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#64748b",
  background: "transparent",
  border: "none",
  padding: "5px 10px",
  cursor: "pointer",
  lineHeight: 1,
};

const textDiffViewBtnActive: CSSProperties = {
  color: "#111827",
  background: "#fff",
};

const textDiffToggle: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 10,
  fontSize: 12,
  fontWeight: 600,
  color: "#374151",
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
};

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

export function PlainTextView({
  loadingSnap,
  diffLoading,
  modules,
  selectedModuleFile,
  activeSnapshot,
  activeCommitId,
  diffResult,
  diffMode,
  setDiffMode,
  commitGroups,
  expandedCommitKey,
  commitFilePreviews,
  commitChangedFileCountByKey,
  commitChangedFileCountLoadingByKey,
  changedCommitKeysForSelectedFile,
  changedCommitKeysForSelectedFileLoading,
  onCommitGroupToggle,
  onPickSnapshotFromCommit,
  handleModuleClick,
  mergeReviewPr = null,
  mergeReviewFromLoading = false,
  mergeTextHunkSides,
  onMergeTextHunkSide,
}: RepoCodeWorkspaceProps) {
  const [diffTextViewMode, setDiffTextViewMode] = useState<"old" | "both" | "new">("both");
  const body = activeSnapshot?.snapshotBody ?? "";

  const plainDiff = diffResult && isPlainTextDiff(diffResult) ? diffResult : null;

  const { diffTextHasOld, diffTextHasNew } = useMemo(() => {
    if (!plainDiff) return { diffTextHasOld: false, diffTextHasNew: false };
    return {
      diffTextHasOld: plainTextDiffHasOld(plainDiff.lines),
      diffTextHasNew: plainTextDiffHasNew(plainDiff.lines),
    };
  }, [plainDiff]);

  useEffect(() => {
    setDiffTextViewMode("both");
  }, [plainDiff?.baseSnapshotId, plainDiff?.targetSnapshotId]);

  useEffect(() => {
    if (!diffMode) setDiffTextViewMode("both");
  }, [diffMode]);

  const baseBranchLabel = mergeReviewPr?.toBranch ?? "base";
  const targetBranchLabel = mergeReviewPr?.fromBranch ?? "incoming";

  const mergeHunks = useMemo(
    () => (plainDiff && mergeReviewPr ? groupPlainTextHunks(plainDiff.lines) : []),
    [plainDiff, mergeReviewPr],
  );

  const mergedPreview = useMemo(() => {
    if (!plainDiff || !mergeReviewPr || !mergeTextHunkSides) return null;
    return materializePlainTextMerge(plainDiff.lines, mergeTextHunkSides);
  }, [plainDiff, mergeReviewPr, mergeTextHunkSides]);

  const hunkPickBtn = (active: boolean): CSSProperties => ({
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 4,
    border: active ? "1px solid #2563eb" : "1px solid #e5e7eb",
    background: active ? "#eff6ff" : "#fff",
    color: active ? "#1d4ed8" : "#64748b",
    cursor: "pointer",
  });

  return (
    <>
      <aside style={styles.sidebar}>
        <div style={styles.sideSection}>
          <div style={styles.sideSectionHeader}>
            <span>Files</span>
            <span style={styles.muted}>{modules.length}</span>
          </div>
          {mergeReviewPr && (
            <div style={{ fontSize: 11, color: "#92400e", padding: "6px 12px", background: "#fffbeb", borderBottom: "1px solid #fde68a" }}>
              Merge review: <strong>{mergeReviewPr.toBranch}</strong> vs incoming <strong>{mergeReviewPr.fromBranch}</strong>
              {mergeReviewFromLoading ? " — loading…" : ""}
            </div>
          )}
          {modules.length === 0 && <p style={{ ...styles.muted, padding: "6px 12px" }}>No text modules ingested yet.</p>}
          {modules.map((mod) => {
            const isSelected = selectedModuleFile === mod.sourceFile;
            return (
              <button
                key={mod.sourceFile}
                style={{ ...styles.moduleBtn, ...(isSelected ? styles.moduleBtnSelected : {}) }}
                onClick={() => handleModuleClick(mod.sourceFile)}
              >
                <span style={styles.moduleIcon}>📄</span>
                <span style={styles.moduleName}>{mod.displayName}</span>
                <span style={styles.moduleCommitCount}>{mod.commits.length}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main style={{ ...styles.viewport, background: "#fff" }}>
        {loadingSnap ? (
          <div style={styles.viewportPlaceholder}>
            <p style={styles.viewportText}>Loading…</p>
          </div>
        ) : activeSnapshot ? (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              style={{
                flexShrink: 0,
                padding: "8px 12px",
                borderBottom: "1px solid #e5e7eb",
                fontSize: 12,
                color: "#64748b",
              }}
            >
              <span style={{ fontWeight: 600, color: "#111827" }}>{activeSnapshot.sourceFile}</span>
              <span style={{ marginLeft: 8, opacity: 0.8 }}>plain-text</span>
            </div>
            <div style={{ flex: 1, overflow: "auto", margin: 0 }}>
              {diffMode && plainDiff && mergeReviewPr && mergeHunks.length > 0 && diffTextViewMode === "both" ? (
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  {mergeHunks.map((hunk) => {
                    const side = mergeTextHunkSides?.[hunk.id] ?? "incoming";
                    return (
                      <div
                        key={hunk.id}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          overflow: "hidden",
                          background: side === "base" ? "#fff7ed" : "#f0fdf4",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            padding: "6px 10px",
                            background: "#f8fafc",
                            borderBottom: "1px solid #e5e7eb",
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#475569" }}>Change {hunk.id}</span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              style={hunkPickBtn(side === "base")}
                              onClick={() => onMergeTextHunkSide?.(hunk.id, "base")}
                            >
                              Use {baseBranchLabel}
                            </button>
                            <button
                              type="button"
                              style={hunkPickBtn(side === "incoming")}
                              onClick={() => onMergeTextHunkSide?.(hunk.id, "incoming")}
                            >
                              Use {targetBranchLabel}
                            </button>
                          </div>
                        </div>
                        <pre style={{ ...textPaneStyle, padding: "8px 10px" }}>
                          {hunk.baseLines.map((line, i) => (
                            <div key={`b${i}`} style={{ color: "#dc2626" }}>
                              − {line}
                            </div>
                          ))}
                          {hunk.incomingLines.map((line, i) => (
                            <div key={`i${i}`} style={{ color: "#16a34a" }}>
                              + {line}
                            </div>
                          ))}
                        </pre>
                      </div>
                    );
                  })}
                  {mergedPreview != null && (
                    <div style={{ borderTop: "2px solid #e5e7eb", paddingTop: 12 }}>
                      <div style={textPaneCaptionStyle}>Merged preview</div>
                      <pre style={textPaneStyle}>{mergedPreview || "(empty)"}</pre>
                    </div>
                  )}
                </div>
              ) : diffMode && plainDiff && diffTextViewMode === "both" ? (
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    lineHeight: 1.45,
                  }}
                >
                  {plainDiff.lines.map((row, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "flex",
                        gap: 8,
                        backgroundColor: LINE_BG[row.type],
                        borderRadius: 2,
                        padding: "1px 4px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      <span style={{ width: 36, flexShrink: 0, color: "#94a3b8", textAlign: "right" }}>
                        {row.oldLine ?? ""}
                      </span>
                      <span style={{ width: 36, flexShrink: 0, color: "#94a3b8", textAlign: "right" }}>
                        {row.newLine ?? ""}
                      </span>
                      <span
                        style={{
                          width: 14,
                          flexShrink: 0,
                          color: row.type === "added" ? "#16a34a" : row.type === "removed" ? "#dc2626" : "#94a3b8",
                        }}
                      >
                        {row.type === "added" ? "+" : row.type === "removed" ? "−" : " "}
                      </span>
                      <span>{row.content}</span>
                    </div>
                  ))}
                </pre>
              ) : diffMode && plainDiff && diffTextViewMode === "old" ? (
                <pre style={textPaneStyle}>
                  <div style={textPaneCaptionStyle}>{baseBranchLabel} (current / base)</div>
                  {plainTextFromBase(plainDiff.lines) || "(empty file)"}
                </pre>
              ) : diffMode && plainDiff && diffTextViewMode === "new" ? (
                <pre style={textPaneStyle}>
                  <div style={textPaneCaptionStyle}>{targetBranchLabel} (incoming)</div>
                  {plainTextFromTarget(plainDiff.lines) || "(empty file)"}
                </pre>
              ) : (
                <pre style={textPaneStyle}>{body || "(empty file)"}</pre>
              )}
            </div>
          </div>
        ) : (
          <div style={styles.viewportPlaceholder}>
            <span style={styles.viewportIcon}>📄</span>
            <p style={styles.viewportText}>No file selected</p>
            <p style={styles.viewportSub}>Push a .txt / .md / etc. then refresh; ForgeHub ingests on push.</p>
          </div>
        )}

        {activeSnapshot && plainDiff && (
          <button
            type="button"
            style={textDiffToggle}
            onClick={() => setDiffMode((d) => !d)}
          >
            {diffMode ? "◑ Line diff" : "◐ Normal"}
          </button>
        )}

        {diffMode && plainDiff && (
          <div style={textDiffViewSegment} role="group" aria-label="Text diff view mode">
            {(["old", "both", "new"] as const).map((m) => (
              <button
                key={m}
                type="button"
                style={{
                  ...textDiffViewBtn,
                  ...(diffTextViewMode === m ? textDiffViewBtnActive : {}),
                  opacity: m === "old" && !diffTextHasOld ? 0.35 : m === "new" && !diffTextHasNew ? 0.35 : 1,
                }}
                disabled={(m === "old" && !diffTextHasOld) || (m === "new" && !diffTextHasNew)}
                onClick={() => setDiffTextViewMode(m)}
                title={
                  m === "old"
                    ? `Show ${baseBranchLabel} only`
                    : m === "new"
                      ? `Show ${targetBranchLabel} only`
                      : "Unified line diff"
                }
              >
                {m === "old" ? "Old" : m === "both" ? "Both" : "New"}
              </button>
            ))}
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
                    {n === 1 && isActiveGroup && diffResult && isPlainTextDiff(diffResult) && (
                      <div style={styles.commitDiffBadges}>
                        {diffResult.summary.added > 0 && (
                          <span style={diffBadgeStyle("#22c55e")}>+{diffResult.summary.added}</span>
                        )}
                        {diffResult.summary.removed > 0 && (
                          <span style={diffBadgeStyle("#ef4444")}>−{diffResult.summary.removed}</span>
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
                          {row.error && <span style={{ fontSize: 10, color: "#dc2626" }}>{row.error}</span>}
                          {!row.loading && row.stats && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              <span style={{ ...diffBadgeStyle("#22c55e"), opacity: row.stats.added > 0 ? 1 : 0.25 }}>
                                +{row.stats.added}
                              </span>
                              <span
                                style={{ ...diffBadgeStyle("#ef4444"), opacity: row.stats.removed > 0 ? 1 : 0.25 }}
                              >
                                −{row.stats.removed}
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
        <div style={{ ...styles.rightPlaceholder, flex: 1 }}>
          One row per Git commit. Multi-file pushes expand to list only files that changed (+/−); pick a file to open. Line
          diff compares to the previous snapshot for that path.
        </div>
      </aside>
    </>
  );
}
