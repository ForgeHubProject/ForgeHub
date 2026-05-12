import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";

export function FallbackWorkspaceView({ workspaceHandlerId }: RepoCodeWorkspaceProps) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#f9fafb",
        minWidth: 0,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center", color: "#64748b" }}>
        <p style={{ fontSize: 16, fontWeight: 600, color: "#334155", margin: 0 }}>No viewer for this artifact type</p>
        <p style={{ fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>
          Handler{" "}
          <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>
            {workspaceHandlerId ?? "unknown"}
          </code>{" "}
          does not have a UI registered in this app yet. The API may still expose snapshot metadata and Git-backed
          files.
        </p>
      </div>
    </div>
  );
}
