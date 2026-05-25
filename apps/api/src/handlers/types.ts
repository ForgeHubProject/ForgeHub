export const GLTF_SCENE_HANDLER_ID = "gltf-scene";
export const PLAIN_TEXT_HANDLER_ID = "plain-text";

export type HandlerId = string;

// ─── Forge wire format (mirrors forge/internal/handler/handler.go) ────────────

export type ChangeKind = "added" | "removed" | "modified";

export type DiffChange = {
  path: string;
  kind: ChangeKind;
  label?: string;
  before?: unknown;
  after?: unknown;
  children?: DiffChange[];
};

export type StructuredDiff = {
  version: "1.0";
  format: string;
  changes: DiffChange[];
};

export type SemanticConflict = {
  path: string;
  ours: unknown;
  theirs: unknown;
};

export type ConflictInfo = {
  conflicts: SemanticConflict[];
};

export type MergeResult = {
  blob: Buffer;
  conflicts?: ConflictInfo;
};

// ─── Handler interface ────────────────────────────────────────────────────────

export type HandlerCapabilities = {
  semanticCompare: boolean;
  semanticMerge: boolean;
};

export type IngestInput = {
  repoId: string;
  sourceFile: string;
  utf8Text: string;
  label: string | null;
  gitCommitSha: string | null;
};

export type ArtifactHandler = {
  id: HandlerId;
  capabilities: HandlerCapabilities;
  matchesPath(path: string): boolean;
  ingestFromUtf8Text(input: IngestInput): Promise<string>;
  /** Produce a format-aware structured diff between two raw file blobs. */
  diff(base: Buffer, head: Buffer): Promise<StructuredDiff>;
  /** Attempt a 3-way semantic merge. Optional — omit if format cannot merge. */
  merge?(base: Buffer, ours: Buffer, theirs: Buffer): Promise<MergeResult>;
};
