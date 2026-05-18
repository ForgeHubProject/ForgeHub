import type { ComponentType } from "react";

export type FileViewerProps = {
  content: string;
  path: string;     // full path from repo root, e.g. "src/components/App.tsx"
  filename: string; // basename only, e.g. "App.tsx"
  gitRef: string;   // git ref (branch name or commit sha)
};

export type FileViewerComponent = ComponentType<FileViewerProps>;
