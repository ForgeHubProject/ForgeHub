import type { FileDiffViewerProps } from "../fileDiffViewerTypes";

/**
 * A binary file with no viewer for its changes (an archive, or an image whose
 * format the repo turned off): said plainly, as GitHub says it, rather than
 * shown as garbled bytes.
 */
export function FallbackFileDiffViewer(_props: FileDiffViewerProps) {
  return <div className="px-4 py-3 text-sm text-gh-muted">Binary file not shown.</div>;
}
