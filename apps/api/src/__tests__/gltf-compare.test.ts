import { describe, it, expect } from "vitest";
import type { Entity } from "@prisma/client";
import { compareGltfSceneSnapshots } from "../handlers/gltf-scene/compare.js";

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: "ent-id",
    snapshotId: "snap-1",
    entityId: "part-a",
    parentEntityId: null,
    kind: "part",
    name: "Part A",
    path: "part-a",
    posX: null,
    posY: null,
    posZ: null,
    rotX: null,
    rotY: null,
    rotZ: null,
    scaleX: null,
    scaleY: null,
    scaleZ: null,
    attributes: "{}",
    renderRef: null,
    ...overrides,
  };
}

function withTransform(overrides: Partial<Entity> = {}): Partial<Entity> {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    ...overrides,
  };
}

describe("compareGltfSceneSnapshots", () => {
  const BASE_ID = "snap-base";
  const TARGET_ID = "snap-target";

  it("returns kind=gltf-scene with correct snapshot IDs", () => {
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [], []);
    expect(result.kind).toBe("gltf-scene");
    expect(result.baseSnapshotId).toBe(BASE_ID);
    expect(result.targetSnapshotId).toBe(TARGET_ID);
  });

  it("empty vs empty → no changes, all zeros", () => {
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [], []);
    expect(result.changes).toHaveLength(0);
    expect(result.summary).toEqual({ added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0 });
  });

  it("entity only in target → added", () => {
    const target = makeEntity({ entityId: "gear", name: "Gear", path: "gear" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [], [target]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.type).toBe("added");
    expect(result.changes[0]!.entityId).toBe("gear");
    expect(result.changes[0]!.before).toBeNull();
    expect(result.changes[0]!.after).not.toBeNull();
    expect(result.summary.added).toBe(1);
  });

  it("entity only in base → removed", () => {
    const base = makeEntity({ entityId: "gear", name: "Gear", path: "gear" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], []);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.type).toBe("removed");
    expect(result.changes[0]!.after).toBeNull();
    expect(result.changes[0]!.before).not.toBeNull();
    expect(result.summary.removed).toBe(1);
  });

  it("identical entities → unchanged, no fieldChanges", () => {
    const ent = makeEntity({ entityId: "gear", ...withTransform() });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [ent], [ent]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.type).toBe("unchanged");
    expect(result.changes[0]!.fieldChanges).toHaveLength(0);
    expect(result.summary.unchanged).toBe(1);
  });

  it("position change → moved (transform-only)", () => {
    const base = makeEntity({ entityId: "gear", ...withTransform({ posX: 0 }) });
    const target = makeEntity({ entityId: "gear", ...withTransform({ posX: 5 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("moved");
    const fc = result.changes[0]!.fieldChanges;
    expect(fc).toHaveLength(1);
    expect(fc[0]!.field).toBe("position");
    expect(fc[0]!.before).toEqual([0, 0, 0]);
    expect(fc[0]!.after).toEqual([5, 0, 0]);
    expect(result.summary.moved).toBe(1);
  });

  it("rotation change → moved (transform-only)", () => {
    const base = makeEntity({ entityId: "gear", ...withTransform({ rotZ: 0 }) });
    const target = makeEntity({ entityId: "gear", ...withTransform({ rotZ: 90 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("moved");
    expect(result.changes[0]!.fieldChanges[0]!.field).toBe("rotation");
  });

  it("scale change → moved (transform-only)", () => {
    const base = makeEntity({ entityId: "gear", ...withTransform({ scaleX: 1 }) });
    const target = makeEntity({ entityId: "gear", ...withTransform({ scaleX: 2 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("moved");
  });

  it("name change → modified (non-transform)", () => {
    const base = makeEntity({ entityId: "gear", name: "Old Name" });
    const target = makeEntity({ entityId: "gear", name: "New Name" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("modified");
    const fc = result.changes[0]!.fieldChanges;
    const nameChange = fc.find((f) => f.field === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.before).toBe("Old Name");
    expect(nameChange!.after).toBe("New Name");
    expect(result.summary.modified).toBe(1);
  });

  it("attributes change → modified", () => {
    const base = makeEntity({ entityId: "gear", attributes: '{"material":"steel"}' });
    const target = makeEntity({ entityId: "gear", attributes: '{"material":"aluminum"}' });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("modified");
    const fc = result.changes[0]!.fieldChanges.find((f) => f.field === "attributes");
    expect(fc).toBeDefined();
  });

  it("parent change → modified", () => {
    const base = makeEntity({ entityId: "gear", parentEntityId: null });
    const target = makeEntity({ entityId: "gear", parentEntityId: "assembly" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("modified");
    const fc = result.changes[0]!.fieldChanges.find((f) => f.field === "parent");
    expect(fc!.before).toBeNull();
    expect(fc!.after).toBe("assembly");
  });

  it("transform + name change → modified (not moved)", () => {
    const base = makeEntity({ entityId: "gear", name: "Old", ...withTransform({ posX: 0 }) });
    const target = makeEntity({ entityId: "gear", name: "New", ...withTransform({ posX: 5 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("modified");
    expect(result.changes[0]!.fieldChanges.length).toBeGreaterThan(1);
  });

  it("approxEq: difference below EPS (1e-4) is treated as unchanged", () => {
    const base = makeEntity({ entityId: "gear", ...withTransform({ posX: 0 }) });
    const target = makeEntity({ entityId: "gear", ...withTransform({ posX: 0.000099 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("unchanged");
  });

  it("approxEq: difference at EPS boundary is detected as moved", () => {
    const base = makeEntity({ entityId: "gear", ...withTransform({ posX: 0 }) });
    const target = makeEntity({ entityId: "gear", ...withTransform({ posX: 0.0002 }) });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("moved");
  });

  it("null vs null transform fields → unchanged (approxEq null pair)", () => {
    const base = makeEntity({ entityId: "gear", posX: null });
    const target = makeEntity({ entityId: "gear", posX: null });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.type).toBe("unchanged");
  });

  it("summary counts match changes array", () => {
    const shared = makeEntity({ entityId: "shared", name: "Same" });
    const added = makeEntity({ entityId: "new", name: "New", path: "new" });
    const removed = makeEntity({ entityId: "old", name: "Old", path: "old" });
    const moved = makeEntity({ entityId: "mv", ...withTransform({ posX: 1 }) });
    const movedTarget = makeEntity({ entityId: "mv", ...withTransform({ posX: 2 }) });

    const result = compareGltfSceneSnapshots(
      BASE_ID,
      TARGET_ID,
      [shared, removed, moved],
      [shared, added, movedTarget],
    );

    const { summary } = result;
    expect(summary.added).toBe(result.changes.filter((c) => c.type === "added").length);
    expect(summary.removed).toBe(result.changes.filter((c) => c.type === "removed").length);
    expect(summary.modified).toBe(result.changes.filter((c) => c.type === "modified").length);
    expect(summary.moved).toBe(result.changes.filter((c) => c.type === "moved").length);
    expect(summary.unchanged).toBe(result.changes.filter((c) => c.type === "unchanged").length);
  });

  it("changes are sorted by path then type", () => {
    const a = makeEntity({ entityId: "a", path: "a" });
    const b = makeEntity({ entityId: "b", path: "b" });
    const c = makeEntity({ entityId: "c", path: "c" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [c, a, b], [c, a, b]);
    const paths = result.changes.map((ch) => ch.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("before and after snapshots are correctly assigned", () => {
    const base = makeEntity({ entityId: "gear", name: "Base Gear" });
    const target = makeEntity({ entityId: "gear", name: "Target Gear" });
    const result = compareGltfSceneSnapshots(BASE_ID, TARGET_ID, [base], [target]);
    expect(result.changes[0]!.before!.name).toBe("Base Gear");
    expect(result.changes[0]!.after!.name).toBe("Target Gear");
  });
});
