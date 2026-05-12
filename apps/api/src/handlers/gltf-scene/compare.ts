import type { Entity } from "@prisma/client";

const EPS = 1e-4;

function approxEq(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < EPS;
}

type EntityRow = {
  id: string;
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  posX: number | null;
  posY: number | null;
  posZ: number | null;
  rotX: number | null;
  rotY: number | null;
  rotZ: number | null;
  scaleX: number | null;
  scaleY: number | null;
  scaleZ: number | null;
  attributes: string;
};

function fmtSnap(e: EntityRow) {
  return {
    entityId: e.entityId,
    parentEntityId: e.parentEntityId,
    kind: e.kind,
    name: e.name,
    path: e.path,
    transform:
      e.posX !== null
        ? {
            position: [e.posX, e.posY!, e.posZ!] as [number, number, number],
            rotationEulerDeg: [e.rotX!, e.rotY!, e.rotZ!] as [number, number, number],
            scale: [e.scaleX!, e.scaleY!, e.scaleZ!] as [number, number, number],
          }
        : null,
    attributes: JSON.parse(e.attributes || "{}") as Record<string, unknown>,
  };
}

export type GltfCompareResult = {
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    unchanged: number;
  };
  changes: Array<{
    entityId: string;
    name: string;
    kind: string;
    path: string;
    type: string;
    fieldChanges: Array<{ field: string; before: unknown; after: unknown }>;
    before: ReturnType<typeof fmtSnap> | null;
    after: ReturnType<typeof fmtSnap> | null;
  }>;
};

export function compareGltfSceneSnapshots(
  baseSnapshotId: string,
  targetSnapshotId: string,
  baseEntities: Entity[],
  targetEntities: Entity[],
): GltfCompareResult {
  const baseMap = new Map(baseEntities.map((e) => [e.entityId, e]));
  const targetMap = new Map(targetEntities.map((e) => [e.entityId, e]));
  const allEntityIds = new Set([...baseMap.keys(), ...targetMap.keys()]);

  const changes: GltfCompareResult["changes"] = [];

  for (const entityId of allEntityIds) {
    const b = baseMap.get(entityId);
    const t = targetMap.get(entityId);

    if (!b && t) {
      changes.push({
        entityId,
        name: t.name,
        kind: t.kind,
        path: t.path,
        type: "added",
        fieldChanges: [],
        before: null,
        after: fmtSnap(t),
      });
    } else if (b && !t) {
      changes.push({
        entityId,
        name: b.name,
        kind: b.kind,
        path: b.path,
        type: "removed",
        fieldChanges: [],
        before: fmtSnap(b),
        after: null,
      });
    } else if (b && t) {
      const fc: Array<{ field: string; before: unknown; after: unknown }> = [];

      const posChanged =
        !approxEq(b.posX, t.posX) || !approxEq(b.posY, t.posY) || !approxEq(b.posZ, t.posZ);
      const rotChanged =
        !approxEq(b.rotX, t.rotX) || !approxEq(b.rotY, t.rotY) || !approxEq(b.rotZ, t.rotZ);
      const scaleChanged =
        !approxEq(b.scaleX, t.scaleX) ||
        !approxEq(b.scaleY, t.scaleY) ||
        !approxEq(b.scaleZ, t.scaleZ);
      const attrChanged =
        JSON.stringify(JSON.parse(b.attributes || "{}")) !==
        JSON.stringify(JSON.parse(t.attributes || "{}"));
      const nameChanged = b.name !== t.name;
      const parentChanged = b.parentEntityId !== t.parentEntityId;

      if (posChanged) fc.push({ field: "position", before: [b.posX, b.posY, b.posZ], after: [t.posX, t.posY, t.posZ] });
      if (rotChanged) fc.push({ field: "rotation", before: [b.rotX, b.rotY, b.rotZ], after: [t.rotX, t.rotY, t.rotZ] });
      if (scaleChanged)
        fc.push({ field: "scale", before: [b.scaleX, b.scaleY, b.scaleZ], after: [t.scaleX, t.scaleY, t.scaleZ] });
      if (attrChanged)
        fc.push({
          field: "attributes",
          before: JSON.parse(b.attributes || "{}"),
          after: JSON.parse(t.attributes || "{}"),
        });
      if (nameChanged) fc.push({ field: "name", before: b.name, after: t.name });
      if (parentChanged) fc.push({ field: "parent", before: b.parentEntityId, after: t.parentEntityId });

      const transformOnly =
        fc.length > 0 && fc.every((c) => c.field === "position" || c.field === "rotation" || c.field === "scale");
      const type = fc.length === 0 ? "unchanged" : transformOnly ? "moved" : "modified";

      changes.push({
        entityId,
        name: t.name,
        kind: t.kind,
        path: t.path,
        type,
        fieldChanges: fc,
        before: fmtSnap(b),
        after: fmtSnap(t),
      });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));

  return {
    baseSnapshotId,
    targetSnapshotId,
    summary: {
      added: changes.filter((c) => c.type === "added").length,
      removed: changes.filter((c) => c.type === "removed").length,
      modified: changes.filter((c) => c.type === "modified").length,
      moved: changes.filter((c) => c.type === "moved").length,
      unchanged: changes.filter((c) => c.type === "unchanged").length,
    },
    changes,
  };
}
