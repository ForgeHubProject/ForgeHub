import type { CSSProperties } from "react";
import { gltfSceneWorkspaceStyles as styles } from "./gltfSceneWorkspace.styles";
import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";
import { isPlainTextDiff } from "../types";

const LINE_BG = {
  added: "#dcfce7",
  removed: "#fee2e2",
  unchanged: "transparent",
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
  setSelectedModuleFile,
  activeSnapshot,
  activeCommitId,
  diffResult,
  diffMode,
  setDiffMode,
  visibleCommits,
  handleModuleClick,
  loadCommit,
}: RepoCodeWorkspaceProps) {
  const body = activeSnapshot?.snapshotBody ?? "";

  return (
    <>
      <aside style={styles.sidebar}>
        <div style={styles.sideSection}>
          <div style={styles.sideSectionHeader}>
            <span>Files</span>
            <span style={styles.muted}>{modules.length}</span>
          </div>
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
              {diffMode && diffResult && isPlainTextDiff(diffResult) ? (
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    lineHeight: 1.45,
                  }}
                >
                  {diffResult.lines.map((row, idx) => (
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
                      <span style={{ width: 14, flexShrink: 0, color: row.type === "added" ? "#16a34a" : row.type === "removed" ? "#dc2626" : "#94a3b8" }}>
                        {row.type === "added" ? "+" : row.type === "removed" ? "−" : " "}
                      </span>
                      <span>{row.content}</span>
                    </div>
                  ))}
                </pre>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {body || "(empty file)"}
                </pre>
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

        {activeSnapshot && diffResult && isPlainTextDiff(diffResult) && (
          <button style={styles.diffToggle} onClick={() => setDiffMode((d) => !d)}>
            {diffMode ? "◑ Line diff" : "◐ Normal"}
          </button>
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
                  {hasDiff && diffResult && isPlainTextDiff(diffResult) && (
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
            );
          })}
        </div>
        <div style={{ ...styles.rightPlaceholder, flex: 1 }}>
          Line-level diff compares this commit to the previous snapshot for this file (same module).
        </div>
      </aside>
    </>
  );
}
