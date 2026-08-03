import type { ComponentType } from "react";
import type { FileDiff } from "../types";
import type { ComputeTier } from "../lib/computeTier";

export type FileDiffViewerProps = {
  file: FileDiff;
  repoBase: string; // e.g. "/owner/repo" — for blob links
  headRef: string;  // commit SHA or branch name — for blob links
  token: string | null; // auth for viewers that fetch (e.g. semantic diffs)
  /**
   * Where a semantic diff is computed (issue #66 P4). Owned by the diff-header
   * chrome (its mode pill), passed down so the FhrFileDiffViewer renders the
   * matching tier. Base text/binary viewers ignore both. Omitted → Tier S.
   */
  computeTier?: ComputeTier;
  /** Lets the viewer switch tiers itself (the slow-server nudge). */
  onComputeTierChange?: (tier: ComputeTier) => void;
};

export type FileDiffViewerComponent = ComponentType<FileDiffViewerProps>;
