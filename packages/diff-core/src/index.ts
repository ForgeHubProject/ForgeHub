import type {
  CanonicalArtifactDocument,
  CanonicalEntity,
  CompareResponse,
  DiffChange
} from "@forgehub/contracts";

function asEntityMap(doc: CanonicalArtifactDocument): Map<string, CanonicalEntity> {
  return new Map(doc.entities.map((entity) => [entity.entityId, entity]));
}

function stableSortChanges(changes: DiffChange[]): DiffChange[] {
  return [...changes].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.entityId !== b.entityId) return a.entityId.localeCompare(b.entityId);
    return a.type.localeCompare(b.type);
  });
}

export function compareCanonicalArtifacts(params: {
  projectId: string;
  baseSnapshotId: string;
  targetSnapshotId: string;
  baseDoc: CanonicalArtifactDocument;
  targetDoc: CanonicalArtifactDocument;
  includeRawJsonDiff?: boolean;
  includeIgnoredStats?: boolean;
}): CompareResponse {
  const start = Date.now();
  const baseMap = asEntityMap(params.baseDoc);
  const targetMap = asEntityMap(params.targetDoc);
  const changes: DiffChange[] = [];

  for (const [entityId, targetEntity] of targetMap.entries()) {
    const baseEntity = baseMap.get(entityId);
    if (!baseEntity) {
      changes.push({
        changeId: `chg_${entityId}_added`,
        type: "added",
        entityId,
        path: targetEntity.path,
        kind: targetEntity.kind,
        before: null,
        after: targetEntity,
        fieldChanges: []
      });
      continue;
    }

    const hasChanged =
      JSON.stringify(baseEntity.transform ?? null) !== JSON.stringify(targetEntity.transform ?? null) ||
      JSON.stringify(baseEntity.attributes) !== JSON.stringify(targetEntity.attributes) ||
      JSON.stringify(baseEntity.renderRef) !== JSON.stringify(targetEntity.renderRef) ||
      baseEntity.parentEntityId !== targetEntity.parentEntityId ||
      baseEntity.opaquePayloadHash !== targetEntity.opaquePayloadHash;

    if (hasChanged) {
      changes.push({
        changeId: `chg_${entityId}_modified`,
        type: "modified",
        entityId,
        path: targetEntity.path,
        kind: targetEntity.kind,
        before: baseEntity,
        after: targetEntity,
        fieldChanges: []
      });
    }
  }

  for (const [entityId, baseEntity] of baseMap.entries()) {
    if (!targetMap.has(entityId)) {
      changes.push({
        changeId: `chg_${entityId}_removed`,
        type: "removed",
        entityId,
        path: baseEntity.path,
        kind: baseEntity.kind,
        before: baseEntity,
        after: null,
        fieldChanges: []
      });
    }
  }

  const sorted = stableSortChanges(changes);
  const summary = {
    added: sorted.filter((c) => c.type === "added").length,
    removed: sorted.filter((c) => c.type === "removed").length,
    modified: sorted.filter((c) => c.type === "modified").length,
    moved: 0,
    reparented: 0
  };

  return {
    diffId: `diff_${params.baseSnapshotId}_${params.targetSnapshotId}`,
    projectId: params.projectId,
    baseSnapshotId: params.baseSnapshotId,
    targetSnapshotId: params.targetSnapshotId,
    summary,
    changes: sorted,
    ignoredStats: params.includeIgnoredStats
      ? { ignoredByRuleCount: 0, ignoredByToleranceCount: 0 }
      : undefined,
    rawJsonDiff: params.includeRawJsonDiff ? { format: "json-patch", operations: [] } : null,
    computedAt: new Date().toISOString(),
    durationMs: Date.now() - start
  };
}
