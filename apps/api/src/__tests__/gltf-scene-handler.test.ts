import { describe, it, expect } from "vitest";
import { gltfSceneHandler } from "../handlers/gltf-scene/index.js";

// A minimal glTF document with one movable node, as JSON text.
function gltfDoc(position: [number, number, number]): string {
  return JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Cube", mesh: 0, translation: position }],
    meshes: [{ primitives: [] }],
  });
}

// Wrap a glTF JSON document in a binary GLB container (12-byte header + one
// JSON chunk), exactly as Blender exports a .glb.
function toGlb(json: string): Buffer {
  const jsonBytes = Buffer.from(json, "utf8");
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const chunkData = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]); // pad with spaces
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(chunkData.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(12 + chunkHeader.length + chunkData.length, 8); // total length
  return Buffer.concat([header, chunkHeader, chunkData]);
}

describe("gltfSceneHandler.matchesPath", () => {
  it("matches both .gltf and .glb, case-insensitively", () => {
    expect(gltfSceneHandler.matchesPath("models/robot.gltf")).toBe(true);
    expect(gltfSceneHandler.matchesPath("models/robot.glb")).toBe(true);
    expect(gltfSceneHandler.matchesPath("models/ROBOT.GLB")).toBe(true);
  });
  it("does not match other extensions", () => {
    expect(gltfSceneHandler.matchesPath("readme.md")).toBe(false);
    expect(gltfSceneHandler.matchesPath("model.step")).toBe(false);
  });
});

describe("gltfSceneHandler.diff", () => {
  it("diffs two .glb binary blobs and reports the moved node", async () => {
    const base = toGlb(gltfDoc([0, 0, 0]));
    const head = toGlb(gltfDoc([5, -2, 0]));
    const diff = await gltfSceneHandler.diff(base, head);

    expect(diff.format).toBe("gltf-scene");
    const cube = diff.changes.find((c) => c.label === "Cube");
    expect(cube?.kind).toBe("modified");
    const pos = cube?.children?.find((c) => c.path === "position");
    expect(pos?.after).toEqual([5, -2, 0]);
  });

  it("gives the same diff whether the blobs are .glb or .gltf JSON", async () => {
    const glb = await gltfSceneHandler.diff(toGlb(gltfDoc([0, 0, 0])), toGlb(gltfDoc([5, -2, 0])));
    const json = await gltfSceneHandler.diff(
      Buffer.from(gltfDoc([0, 0, 0])),
      Buffer.from(gltfDoc([5, -2, 0])),
    );
    expect(glb).toEqual(json);
  });

  it("treats an empty base blob as an added file (no throw on GLB add)", async () => {
    const diff = await gltfSceneHandler.diff(Buffer.alloc(0), toGlb(gltfDoc([1, 1, 1])));
    const cube = diff.changes.find((c) => c.label === "Cube");
    expect(cube?.kind).toBe("added");
  });
});
