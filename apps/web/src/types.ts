export type User = {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
};

export type Repo = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerHandle: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotSummary = {
  id: string;
  label: string | null;
  sourceFile: string;
  schemaVersion: string;
  createdAt: string;
  gitCommitSha: string | null;
};

export type Transform = {
  position: [number, number, number];
  rotationEulerDeg: [number, number, number];
  scale: [number, number, number];
};

export type Entity = {
  id: string;
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  transform: Transform | null;
  attributes: Record<string, unknown>;
  renderRef: { type: string; meshIndex: number } | null;
};

export type Constraint = {
  id: string;
  entityAId: string;
  entityBId: string;
  positionFixed: boolean;
  rotationFixed: boolean;
  createdAt: string;
};

export type Snapshot = SnapshotSummary & {
  repoId: string;
  entities: Entity[];
  constraints: Constraint[];
};

export type TreeNode = Entity & { children: TreeNode[] };

export type DiffEntitySnapshot = {
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  transform: Transform | null;
  attributes: Record<string, unknown>;
};

export type DiffChangeType = "added" | "removed" | "modified" | "moved" | "unchanged";

export type DiffChange = {
  entityId: string;
  name: string;
  kind: string;
  path: string;
  type: DiffChangeType;
  fieldChanges: Array<{ field: string; before: unknown; after: unknown }>;
  before: DiffEntitySnapshot | null;
  after: DiffEntitySnapshot | null;
};

export type DiffResult = {
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: { added: number; removed: number; modified: number; moved: number; unchanged: number };
  changes: DiffChange[];
};
