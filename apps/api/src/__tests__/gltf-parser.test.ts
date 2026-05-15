import { describe, it, expect } from "vitest";
import { parseGltf } from "../gltf-parser.js";
import type { GltfDocument } from "../gltf-parser.js";

function makeDoc(overrides: Partial<GltfDocument> = {}): GltfDocument {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], name: "Scene" }],
    nodes: [{ name: "Root" }],
    ...overrides,
  };
}

describe("parseGltf", () => {
  it("throws when no scenes present", () => {
    expect(() => parseGltf(makeDoc({ scenes: [] }))).toThrow("glTF has no scenes");
  });

  it("throws when scene has no root nodes", () => {
    expect(() => parseGltf(makeDoc({ scenes: [{ nodes: [] }] }))).toThrow("glTF scene has no root nodes");
  });

  it("single leaf node without mesh → kind=module", () => {
    const doc = makeDoc({ nodes: [{ name: "Bolt" }] });
    const entities = parseGltf(doc);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.kind).toBe("module");
    expect(entities[0]!.name).toBe("Bolt");
  });

  it("single node with mesh → kind=part", () => {
    const doc = makeDoc({ nodes: [{ name: "Gear", mesh: 0 }] });
    const entities = parseGltf(doc);
    expect(entities[0]!.kind).toBe("part");
    expect(entities[0]!.renderRef).toEqual({ type: "mesh", meshIndex: 0 });
  });

  it("node with children → kind=assembly", () => {
    const doc = makeDoc({
      nodes: [{ name: "Assembly", children: [1] }, { name: "Part", mesh: 0 }],
    });
    const entities = parseGltf(doc);
    const assembly = entities.find((e) => e.name === "Assembly");
    expect(assembly!.kind).toBe("assembly");
  });

  it("entityId and path are the slugified name", () => {
    const doc = makeDoc({ nodes: [{ name: "My Part" }] });
    const entities = parseGltf(doc);
    expect(entities[0]!.entityId).toBe("my-part");
    expect(entities[0]!.path).toBe("my-part");
  });

  it("parentEntityId is null for root node", () => {
    const doc = makeDoc({ nodes: [{ name: "Root" }] });
    expect(parseGltf(doc)[0]!.parentEntityId).toBeNull();
  });

  it("child gets parent's entityId as parentEntityId", () => {
    const doc = makeDoc({
      nodes: [{ name: "Assembly", children: [1] }, { name: "Part", mesh: 0 }],
    });
    const entities = parseGltf(doc);
    const part = entities.find((e) => e.name === "Part")!;
    const assembly = entities.find((e) => e.name === "Assembly")!;
    expect(part.parentEntityId).toBe(assembly.entityId);
  });

  it("child path includes parent path prefix", () => {
    const doc = makeDoc({
      nodes: [{ name: "Assembly", children: [1] }, { name: "Part" }],
    });
    const entities = parseGltf(doc);
    const part = entities.find((e) => e.name === "Part")!;
    expect(part.path).toBe("assembly.part");
  });

  it("node with translation → transform is populated", () => {
    const doc = makeDoc({
      nodes: [{ name: "Moved", translation: [1, 2, 3] }],
    });
    const entities = parseGltf(doc);
    expect(entities[0]!.transform).not.toBeNull();
    expect(entities[0]!.transform!.position).toEqual([1, 2, 3]);
  });

  it("node with scale → transform is populated", () => {
    const doc = makeDoc({
      nodes: [{ name: "Scaled", scale: [2, 2, 2] }],
    });
    const entities = parseGltf(doc);
    expect(entities[0]!.transform!.scale).toEqual([2, 2, 2]);
  });

  it("identity quaternion [0,0,0,1] → rotationEulerDeg is [0,0,0]", () => {
    const doc = makeDoc({
      nodes: [{ name: "Node", rotation: [0, 0, 0, 1] }],
    });
    const entities = parseGltf(doc);
    const rot = entities[0]!.transform!.rotationEulerDeg;
    rot.forEach((deg) => expect(Math.abs(deg)).toBeLessThan(0.001));
  });

  it("node without transform → transform is null", () => {
    const doc = makeDoc({ nodes: [{ name: "Plain" }] });
    expect(parseGltf(doc)[0]!.transform).toBeNull();
  });

  it("attributes defaults to empty object", () => {
    const doc = makeDoc({ nodes: [{ name: "Node" }] });
    expect(parseGltf(doc)[0]!.attributes).toEqual({});
  });

  it("multiple root nodes → synthetic root assembly created", () => {
    const doc: GltfDocument = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1], name: "MyScene" }],
      nodes: [{ name: "A" }, { name: "B" }],
    };
    const entities = parseGltf(doc);
    const root = entities.find((e) => e.parentEntityId === null)!;
    expect(root.kind).toBe("assembly");
    expect(root.name).toBe("MyScene");
    // A and B should be children of the synthetic root
    const children = entities.filter((e) => e.parentEntityId === root.entityId);
    expect(children).toHaveLength(2);
  });

  it("duplicate sibling names get unique path suffixes", () => {
    const doc = makeDoc({
      nodes: [{ name: "Assembly", children: [1, 2] }, { name: "Part" }, { name: "Part" }],
    });
    const entities = parseGltf(doc);
    const parts = entities.filter((e) => e.name === "Part");
    expect(parts).toHaveLength(2);
    const paths = parts.map((p) => p.path);
    expect(paths[0]).not.toBe(paths[1]);
    // Second duplicate gets a -1 suffix
    expect(paths.some((p) => p.endsWith("-1"))).toBe(true);
  });

  it("name missing from node → falls back to node-{index}", () => {
    const doc = makeDoc({ nodes: [{}] });
    const entities = parseGltf(doc);
    expect(entities[0]!.name).toBe("node-0");
  });

  it("deeply nested hierarchy → entities count matches node count", () => {
    const doc: GltfDocument = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "Root", children: [1] },
        { name: "Mid", children: [2] },
        { name: "Leaf", mesh: 0 },
      ],
    };
    const entities = parseGltf(doc);
    expect(entities).toHaveLength(3);
  });
});
