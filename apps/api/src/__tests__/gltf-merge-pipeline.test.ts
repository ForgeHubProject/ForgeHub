/**
 * End-to-end glTF merge resolution pipeline tests.
 *
 * Tests the full chain:
 *   parseGltf → Entity rows → materializeGltfMerge → valid glTF JSON
 *
 * Each scenario mirrors a real merge decision:
 *   - Pick which side's transform to use for a moved entity
 *   - Include or exclude an entity added only in the incoming branch
 *   - Keep or drop an entity removed from the incoming branch
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@prisma/client";
import { parseGltf, type GltfDocument } from "../gltf-parser.js";
import { materializeGltfMerge } from "../merge/gltf-resolve.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Convert a ParsedEntity into an Entity row as Prisma would store it.
 * The id and snapshotId are synthetic — only used to satisfy the type.
 */
function toEntityRow(e: ReturnType<typeof parseGltf>[number], snapshotId = "snap"): Entity {
  return {
    id: `row-${e.entityId}`,
    snapshotId,
    entityId: e.entityId,
    parentEntityId: e.parentEntityId,
    kind: e.kind,
    name: e.name,
    path: e.path,
    posX: e.transform?.position[0] ?? null,
    posY: e.transform?.position[1] ?? null,
    posZ: e.transform?.position[2] ?? null,
    rotX: e.transform?.rotationEulerDeg[0] ?? null,
    rotY: e.transform?.rotationEulerDeg[1] ?? null,
    rotZ: e.transform?.rotationEulerDeg[2] ?? null,
    scaleX: e.transform?.scale[0] ?? null,
    scaleY: e.transform?.scale[1] ?? null,
    scaleZ: e.transform?.scale[2] ?? null,
    attributes: JSON.stringify(e.attributes),
    renderRef: e.renderRef ? JSON.stringify(e.renderRef) : null,
  };
}

function makeDoc(nodes: NonNullable<GltfDocument["nodes"]>, sceneName = "Scene"): GltfDocument {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ name: sceneName, nodes: [0] }],
    nodes,
  };
}

/** Parse a document and produce Entity rows for use in materializeGltfMerge. */
function entitiesFrom(doc: GltfDocument, snapshotId = "snap"): Entity[] {
  return parseGltf(doc).map((e) => toEntityRow(e, snapshotId));
}

// Base: Assembly → Part A (at [0,0,0]) + Part B (at [1,0,0])
const BASE_DOC = makeDoc([
  { name: "Assembly", children: [1, 2] },
  { name: "Part A", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "Part B", translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);

// Incoming: Part A moved to [5,0,0]
const INCOMING_MOVED_DOC = makeDoc([
  { name: "Assembly", children: [1, 2] },
  { name: "Part A", translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "Part B", translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);

// Incoming: Part C added (Assembly → Part A + Part B + Part C)
const INCOMING_ADDED_DOC = makeDoc([
  { name: "Assembly", children: [1, 2, 3] },
  { name: "Part A", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "Part B", translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "Part C", translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);

// Incoming: Part B removed (Assembly → Part A only)
const INCOMING_REMOVED_DOC = makeDoc([
  { name: "Assembly", children: [1] },
  { name: "Part A", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_JSON = JSON.stringify(BASE_DOC);
const BASE_ENTITIES = entitiesFrom(BASE_DOC, "snap-base");

function merge(
  incomingJson: string,
  incomingEntities: Entity[],
  entitySides: Record<string, "base" | "incoming"> = {},
  fieldSides: Record<string, "base" | "incoming"> = {},
  fieldChanges: Map<string, Array<{ field: string }>> = new Map(),
) {
  return materializeGltfMerge(
    BASE_JSON, incomingJson,
    BASE_ENTITIES, incomingEntities,
    entitySides, fieldSides, fieldChanges,
  );
}

// ─── No-op merge ─────────────────────────────────────────────────────────────

describe("no-change merge", () => {
  it("identical base and incoming → output is valid glTF with same node count", () => {
    const result = merge(BASE_JSON, BASE_ENTITIES);
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities).toHaveLength(BASE_ENTITIES.length);
  });

  it("all entity IDs are preserved in the no-change case", () => {
    const result = merge(BASE_JSON, BASE_ENTITIES);
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    const ids = entities.map((e) => e.entityId).sort();
    const expected = BASE_ENTITIES.map((e) => e.entityId).sort();
    expect(ids).toEqual(expected);
  });
});

// ─── Transform pick (moved entity) ───────────────────────────────────────────

describe("transform / position pick", () => {
  const INC_ENTITIES = entitiesFrom(INCOMING_MOVED_DOC, "snap-inc");
  const INC_JSON = JSON.stringify(INCOMING_MOVED_DOC);
  const CHANGES = new Map([["assembly.part-a", [{ field: "position" }]]]);

  it("picking incoming position → Part A gets incoming translation [5,0,0]", () => {
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, CHANGES);
    const doc = JSON.parse(result) as GltfDocument;
    const partANode = doc.nodes![1]!;
    expect(partANode.translation).toEqual([5, 0, 0]);
  });

  it("picking base position for Part A → keeps original translation [0,0,0]", () => {
    const fieldSides = { "assembly.part-a:position": "base" as const };
    const result = merge(INC_JSON, INC_ENTITIES, {}, fieldSides, CHANGES);
    const doc = JSON.parse(result) as GltfDocument;
    const partANode = doc.nodes![1]!;
    expect(partANode.translation).toEqual([0, 0, 0]);
  });

  it("Part B is unaffected regardless of Part A's position pick", () => {
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, CHANGES);
    const doc = JSON.parse(result) as GltfDocument;
    const partBNode = doc.nodes![2]!;
    expect(partBNode.translation).toEqual([1, 0, 0]);
  });

  it("output is a valid parseable glTF document after position pick", () => {
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, CHANGES);
    expect(() => parseGltf(JSON.parse(result) as GltfDocument)).not.toThrow();
  });
});

// ─── Entity added in incoming ─────────────────────────────────────────────────

describe("entity added in incoming branch", () => {
  const INC_ENTITIES = entitiesFrom(INCOMING_ADDED_DOC, "snap-inc");
  const INC_JSON = JSON.stringify(INCOMING_ADDED_DOC);

  it("picking incoming for new entity → Part C appears in result", () => {
    // Default side is 'incoming', so Part C (only in incoming) is included
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part C")).toBe(true);
  });

  it("picking base for new entity → Part C is excluded from result", () => {
    const partCId = INC_ENTITIES.find((e) => e.name === "Part C")!.entityId;
    const result = merge(INC_JSON, INC_ENTITIES, { [partCId]: "base" }, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part C")).toBe(false);
  });

  it("existing entities (Part A, Part B) are still present when Part C is included", () => {
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part A")).toBe(true);
    expect(entities.some((e) => e.name === "Part B")).toBe(true);
  });

  it("output remains a valid parseable glTF after entity inclusion", () => {
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, new Map());
    expect(() => parseGltf(JSON.parse(result) as GltfDocument)).not.toThrow();
  });
});

// ─── Entity removed in incoming ───────────────────────────────────────────────

describe("entity removed in incoming branch", () => {
  const INC_ENTITIES = entitiesFrom(INCOMING_REMOVED_DOC, "snap-inc");
  const INC_JSON = JSON.stringify(INCOMING_REMOVED_DOC);

  it("picking base for removed entity → Part B is preserved", () => {
    // Default for entity only-in-base is 'base', so Part B is kept
    const result = merge(INC_JSON, INC_ENTITIES, {}, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part B")).toBe(true);
  });

  it("picking incoming for removed entity → Part B is dropped", () => {
    const partBId = BASE_ENTITIES.find((e) => e.name === "Part B")!.entityId;
    const result = merge(INC_JSON, INC_ENTITIES, { [partBId]: "incoming" }, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part B")).toBe(false);
  });

  it("Part A is always preserved regardless of Part B pick", () => {
    const partBId = BASE_ENTITIES.find((e) => e.name === "Part B")!.entityId;
    const result = merge(INC_JSON, INC_ENTITIES, { [partBId]: "incoming" }, {}, new Map());
    const doc = JSON.parse(result) as GltfDocument;
    const entities = parseGltf(doc);
    expect(entities.some((e) => e.name === "Part A")).toBe(true);
  });

  it("output is a valid parseable glTF after entity removal", () => {
    const partBId = BASE_ENTITIES.find((e) => e.name === "Part B")!.entityId;
    const result = merge(INC_JSON, INC_ENTITIES, { [partBId]: "incoming" }, {}, new Map());
    expect(() => parseGltf(JSON.parse(result) as GltfDocument)).not.toThrow();
  });
});

// ─── Name field pick ──────────────────────────────────────────────────────────

describe("entity name pick", () => {
  /**
   * The entity ID is path-based (slugified name), so renaming a node in the
   * glTF document would produce a different entityId. The "name" field pick
   * applies when a display-name metadata change is recorded against a stable
   * entityId — simulated here by constructing incoming entity rows that share
   * the base entityId but carry the new name.
   */
  const PART_A = BASE_ENTITIES.find((e) => e.name === "Part A")!;
  const INC_ENTITIES: Entity[] = BASE_ENTITIES.map((e) =>
    e.entityId === PART_A.entityId
      ? { ...e, name: "Part A Renamed", snapshotId: "snap-inc" }
      : { ...e, snapshotId: "snap-inc" },
  );
  const CHANGES = new Map([[PART_A.entityId, [{ field: "name" }]]]);

  it("picking incoming name → node gets the new name", () => {
    const result = merge(BASE_JSON, INC_ENTITIES, {}, {}, CHANGES);
    const doc = JSON.parse(result) as GltfDocument;
    expect(doc.nodes![1]!.name).toBe("Part A Renamed");
  });

  it("picking base name → original node name is preserved", () => {
    const fieldSides = { [`${PART_A.entityId}:name`]: "base" as const };
    const result = merge(BASE_JSON, INC_ENTITIES, {}, fieldSides, CHANGES);
    const doc = JSON.parse(result) as GltfDocument;
    expect(doc.nodes![1]!.name).toBe("Part A");
  });
});
