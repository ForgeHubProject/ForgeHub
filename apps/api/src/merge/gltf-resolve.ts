import type { Entity } from "@prisma/client";
import type { GltfDocument } from "../gltf-parser.js";
import { parseGltf, type ParsedEntity } from "../gltf-parser.js";

export type MergeSide = "base" | "incoming";

export type GltfEntityResolution = { entityId: string; side: MergeSide };
export type GltfFieldResolution = { entityId: string; field: string; side: MergeSide };

function eulerDegToQuat(roll: number, pitch: number, yaw: number): [number, number, number, number] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const r = toRad(roll) * 0.5;
  const p = toRad(pitch) * 0.5;
  const y = toRad(yaw) * 0.5;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  return [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

function entityRowToParsed(e: Entity): ParsedEntity {
  const hasTransform = e.posX !== null;
  return {
    entityId: e.entityId,
    parentEntityId: e.parentEntityId,
    kind: e.kind,
    name: e.name,
    path: e.path,
    transform: hasTransform
      ? {
          position: [e.posX!, e.posY!, e.posZ!],
          rotationEulerDeg: [e.rotX!, e.rotY!, e.rotZ!],
          scale: [e.scaleX!, e.scaleY!, e.scaleZ!],
        }
      : null,
    attributes: JSON.parse(e.attributes || "{}") as Record<string, unknown>,
    renderRef: e.renderRef ? (JSON.parse(e.renderRef) as { type: string; meshIndex: number }) : null,
  };
}

/** entityId → glTF node index (same walk order as parseGltf). */
export function buildEntityNodeIndexMap(doc: GltfDocument): Map<string, number> {
  const map = new Map<string, number>();
  const nodes = doc.nodes ?? [];
  const scenes = doc.scenes ?? [];
  const defaultScene = scenes[doc.scene ?? 0];
  if (!defaultScene) return map;

  const rootIndices = defaultScene.nodes ?? [];
  const seenPaths = new Set<string>();

  function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
  }

  function uniquePath(base: string): string {
    if (!seenPaths.has(base)) {
      seenPaths.add(base);
      return base;
    }
    let i = 1;
    while (seenPaths.has(`${base}-${i}`)) i++;
    const p = `${base}-${i}`;
    seenPaths.add(p);
    return p;
  }

  let syntheticRootId: string | null = null;
  if (rootIndices.length > 1) {
    const sceneName = defaultScene.name ?? "scene";
    syntheticRootId = uniquePath(slugify(sceneName));
    map.set(syntheticRootId, -1);
  }

  function walk(nodeIndex: number, parentEntityId: string | null, parentPath: string) {
    const node = nodes[nodeIndex];
    if (!node) return;
    const rawName = node.name ?? `node-${nodeIndex}`;
    const slug = slugify(rawName);
    const basePath = parentPath ? `${parentPath}.${slug}` : slug;
    const entityPath = uniquePath(basePath);
    map.set(entityPath, nodeIndex);
    for (const childIndex of node.children ?? []) {
      walk(childIndex, entityPath, entityPath);
    }
  }

  for (const rootIndex of rootIndices) {
    walk(rootIndex, syntheticRootId, "");
  }
  return map;
}

function applyParsedToNode(
  node: NonNullable<GltfDocument["nodes"]>[number],
  ent: ParsedEntity,
): void {
  node.name = ent.name;
  if (ent.transform) {
    node.translation = [...ent.transform.position];
    node.rotation = eulerDegToQuat(...ent.transform.rotationEulerDeg);
    node.scale = [...ent.transform.scale];
  }
}

function fieldKey(entityId: string, field: string): string {
  return `${entityId}:${field}`;
}

function pickFieldValue(
  field: string,
  base: Entity,
  incoming: Entity,
  side: MergeSide,
): unknown {
  switch (field) {
    case "position":
      return side === "base" ? [base.posX, base.posY, base.posZ] : [incoming.posX, incoming.posY, incoming.posZ];
    case "rotation":
      return side === "base"
        ? [base.rotX, base.rotY, base.rotZ]
        : [incoming.rotX, incoming.rotY, incoming.rotZ];
    case "scale":
      return side === "base"
        ? [base.scaleX, base.scaleY, base.scaleZ]
        : [incoming.scaleX, incoming.scaleY, incoming.scaleZ];
    case "name":
      return side === "base" ? base.name : incoming.name;
    case "parent":
      return side === "base" ? base.parentEntityId : incoming.parentEntityId;
    default:
      return null;
  }
}

function applyFieldToParsed(ent: ParsedEntity, field: string, value: unknown): void {
  if (field === "name" && typeof value === "string") ent.name = value;
  if (field === "parent" && (typeof value === "string" || value === null)) ent.parentEntityId = value as string | null;
  if (!ent.transform) ent.transform = { position: [0, 0, 0], rotationEulerDeg: [0, 0, 0], scale: [1, 1, 1] };
  if (field === "position" && Array.isArray(value)) {
    ent.transform.position = value as [number, number, number];
  }
  if (field === "rotation" && Array.isArray(value)) {
    ent.transform.rotationEulerDeg = value as [number, number, number];
  }
  if (field === "scale" && Array.isArray(value)) {
    ent.transform.scale = value as [number, number, number];
  }
}

function buildMergedEntities(
  baseEntities: Entity[],
  incomingEntities: Entity[],
  entitySides: Record<string, MergeSide>,
  fieldSides: Record<string, MergeSide>,
  fieldChangesByEntity: Map<string, Array<{ field: string }>>,
  defaultSide: MergeSide = "incoming",
): Map<string, ParsedEntity> {
  const baseMap = new Map(baseEntities.map((e) => [e.entityId, e]));
  const incMap = new Map(incomingEntities.map((e) => [e.entityId, e]));
  const out = new Map<string, ParsedEntity>();

  for (const entityId of new Set([...baseMap.keys(), ...incMap.keys()])) {
    const b = baseMap.get(entityId);
    const t = incMap.get(entityId);

    if (!b && t) {
      if ((entitySides[entityId] ?? defaultSide) === "incoming") {
        out.set(entityId, entityRowToParsed(t));
      }
      continue;
    }
    if (b && !t) {
      if ((entitySides[entityId] ?? "base") === "base") {
        out.set(entityId, entityRowToParsed(b));
      }
      continue;
    }
    if (!b || !t) continue;

    const entitySide = entitySides[entityId] ?? defaultSide;
    const merged = entityRowToParsed(entitySide === "base" ? b : t);
    const fields = fieldChangesByEntity.get(entityId) ?? [];
    for (const { field } of fields) {
      const fk = fieldKey(entityId, field);
      const side = fieldSides[fk] ?? entitySide;
      const value = pickFieldValue(field, b, t, side);
      if (value !== null) applyFieldToParsed(merged, field, value);
    }
    out.set(entityId, merged);
  }
  return out;
}

/** Deep-clone a node and its descendants; returns new root index in `target.nodes`. */
function cloneNodeSubtree(
  target: GltfDocument,
  source: GltfDocument,
  sourceIndex: number,
): number {
  const sourceNodes = source.nodes ?? [];
  const src = sourceNodes[sourceIndex];
  if (!src) throw new Error(`Invalid node index ${sourceIndex}`);

  const clone = JSON.parse(JSON.stringify(src)) as (typeof sourceNodes)[number];
  if (clone.children?.length) {
    clone.children = clone.children.map((ci) => cloneNodeSubtree(target, source, ci));
  }
  const nodes = target.nodes ?? [];
  const newIndex = nodes.length;
  nodes.push(clone);
  target.nodes = nodes;
  return newIndex;
}

function attachChildToParent(doc: GltfDocument, parentEntityId: string | null, childIndex: number): void {
  const parentIndex = parentEntityId
    ? buildEntityNodeIndexMap(doc).get(parentEntityId)
    : undefined;
  const scenes = doc.scenes ?? [];
  const scene = scenes[doc.scene ?? 0];
  if (parentIndex !== undefined && parentIndex >= 0) {
    const parent = doc.nodes![parentIndex]!;
    parent.children = [...(parent.children ?? []), childIndex];
    return;
  }
  if (scene) {
    scene.nodes = [...(scene.nodes ?? []), childIndex];
  }
}

function removeNodeFromDoc(doc: GltfDocument, nodeIndex: number): void {
  const nodes = doc.nodes ?? [];
  const scenes = doc.scenes ?? [];
  const scene = scenes[doc.scene ?? 0];
  if (!scene) return;

  function stripFromChildren(list: number[] | undefined): number[] {
    return (list ?? []).filter((i) => i !== nodeIndex);
  }

  for (const n of nodes) {
    if (n.children) n.children = stripFromChildren(n.children);
  }
  scene.nodes = stripFromChildren(scene.nodes);
  nodes[nodeIndex] = { name: "__removed__" };
}

/**
 * Apply per-entity / per-field merge picks and return serialized glTF JSON.
 * Starts from the base-branch file and patches nodes to match merged entities.
 */
export function materializeGltfMerge(
  baseJson: string,
  incomingJson: string,
  baseEntities: Entity[],
  incomingEntities: Entity[],
  entitySides: Record<string, MergeSide>,
  fieldSides: Record<string, MergeSide>,
  fieldChangesByEntity: Map<string, Array<{ field: string }>>,
): string {
  const baseDoc = JSON.parse(baseJson) as GltfDocument;
  const incomingDoc = JSON.parse(incomingJson) as GltfDocument;

  const merged = buildMergedEntities(
    baseEntities,
    incomingEntities,
    entitySides,
    fieldSides,
    fieldChangesByEntity,
  );

  const baseMap = buildEntityNodeIndexMap(baseDoc);
  const incMap = buildEntityNodeIndexMap(incomingDoc);

  for (const [entityId, ent] of merged) {
    const nodeIdx = baseMap.get(entityId);
    if (nodeIdx !== undefined && nodeIdx >= 0) {
      applyParsedToNode(baseDoc.nodes![nodeIdx]!, ent);
      continue;
    }
    const incIdx = incMap.get(entityId);
    if (incIdx !== undefined && incIdx >= 0) {
      const newIdx = cloneNodeSubtree(baseDoc, incomingDoc, incIdx);
      attachChildToParent(baseDoc, ent.parentEntityId, newIdx);
    }
  }

  for (const e of baseEntities) {
    if (!merged.has(e.entityId)) {
      const idx = baseMap.get(e.entityId);
      if (idx !== undefined && idx >= 0) removeNodeFromDoc(baseDoc, idx);
    }
  }

  // Validate parse still works
  parseGltf(baseDoc);
  return JSON.stringify(baseDoc, null, 2) + "\n";
}
