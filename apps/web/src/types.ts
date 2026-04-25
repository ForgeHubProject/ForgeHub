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
