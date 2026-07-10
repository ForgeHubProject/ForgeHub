import type { ComponentType } from "react";
import type { FileDiff } from "../types";

export type FileDiffViewerProps = {
  file: FileDiff;
  repoBase: string; // e.g. "/owner/repo" — for blob links
  headRef: string;  // commit SHA or branch name — for blob links
  token: string | null; // auth for viewers that fetch (e.g. semantic diffs)
};

export type FileDiffViewerComponent = ComponentType<FileDiffViewerProps>;
