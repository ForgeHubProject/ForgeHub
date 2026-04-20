export type EntityKind = "assembly" | "module" | "part" | "annotation" | "primitive2d";

export type Vec3 = [number, number, number];

export interface EntityTransform {
  position: Vec3;
  rotationEulerDeg: Vec3;
  scale: Vec3;
}

export interface RenderRef {
  type: "mesh" | "primitive2d" | "asset-ref";
  assetId: string;
  subPath: string | null;
}

export interface CanonicalEntity {
  entityId: string;
  parentEntityId: string | null;
  kind: EntityKind;
  name: string;
  path: string;
  transform?: EntityTransform;
  attributes: Record<string, unknown>;
  renderRef: RenderRef | null;
  opaquePayloadHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalArtifactDocument {
  schemaVersion: string;
  projectId: string;
  rootEntityId: string;
  entities: CanonicalEntity[];
  metadata: {
    sourceFormat: string;
    importedAt: string;
    unitSystem: string;
  };
}

export type DiffChangeType = "added" | "removed" | "modified" | "moved" | "reparented";

export interface FieldChange {
  fieldPath: string;
  changeKind:
    | "value"
    | "numeric_tolerance_exceeded"
    | "parent_changed"
    | "render_ref_changed"
    | "opaque_payload_changed";
  before: unknown;
  after: unknown;
}

export interface DiffChange {
  changeId: string;
  type: DiffChangeType;
  entityId: string;
  path: string;
  kind: EntityKind;
  before: Partial<CanonicalEntity> | null;
  after: Partial<CanonicalEntity> | null;
  fieldChanges: FieldChange[];
}

export interface CompareOptions {
  includeRawJsonDiff?: boolean;
  includeIgnoredStats?: boolean;
}

export interface CompareRequest {
  projectId: string;
  baseSnapshotId: string;
  targetSnapshotId: string;
  options?: CompareOptions;
}

export interface CompareResponse {
  diffId: string;
  projectId: string;
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    reparented: number;
  };
  changes: DiffChange[];
  ignoredStats?: {
    ignoredByRuleCount: number;
    ignoredByToleranceCount: number;
  };
  rawJsonDiff: unknown | null;
  computedAt: string;
  durationMs: number;
}
