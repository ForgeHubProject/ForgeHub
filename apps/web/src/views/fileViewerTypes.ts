import type { ComponentType } from "react";
import type { BlameHunk } from "../types";

/** An inclusive 1-based line range selected in the blob view (for #L anchors). */
export type LineRange = { start: number; end: number };

export type FileViewerProps = {
  content: string;
  path: string;     // full path from repo root, e.g. "src/components/App.tsx"
  filename: string; // basename only, e.g. "App.tsx"
  gitRef: string;   // git ref (branch name or commit sha)
  /** Repo base path (e.g. "/alice/repo"), used to build blame commit links. */
  repoBase?: string;
  /** Currently selected line range (highlighted), driven by the URL hash. */
  selectedRange?: LineRange | null;
  /** Called when a line number is clicked (shift = extend the range). */
  onLineSelect?: (line: number, shift: boolean) => void;
  /** Per-hunk line authorship; when present a blame gutter is shown. */
  blame?: BlameHunk[] | null;
};

export type FileViewerComponent = ComponentType<FileViewerProps>;
