import { vi, describe, it, expect, beforeEach } from "vitest";

// The handler ingest ABI takes BYTES (`ingest({ bytes })`), not a UTF-8 string:
// stringifying first destroyed binary containers (.glb) before the handler that
// knows how to decode them ever saw the payload. These tests pin that contract.

vi.mock("../prisma.js", () => ({
  prisma: {
    snapshot: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { gltfSceneHandler } from "../handlers/gltf-scene/index.js";
import { plainTextHandler, PLAIN_TEXT_MAX_BYTES } from "../handlers/plain-text/index.js";
import { ingestDesignSnapshot } from "../design-ingest.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A two-node glTF scene (arm ▸ grip), as JSON text. */
function gltfJson(): string {
  return JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], name: "Scene" }],
    nodes: [
      { name: "Arm", mesh: 0, translation: [1, 2, 3], children: [1] },
      { name: "Grip", mesh: 1, translation: [0, 0, 4] },
    ],
    meshes: [{ primitives: [] }, { primitives: [] }],
  });
}

/** Wrap glTF JSON in a binary GLB container (12-byte header + one JSON chunk),
 *  exactly as Blender exports a .glb. */
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
  header.writeUInt32LE(12 + chunkHeader.length + chunkData.length, 8);
  return Buffer.concat([header, chunkHeader, chunkData]);
}

type EntityRow = {
  entityId: string; parentEntityId: string | null; kind: string; name: string; path: string;
  posX: number | null; posY: number | null; posZ: number | null;
};

/** The entity rows the last snapshot.create wrote, in insertion order. */
function createdEntities(): EntityRow[] {
  const call = vi.mocked(prisma.snapshot.create).mock.calls.at(-1)?.[0] as
    | { data: { entities: { create: EntityRow[] } } }
    | undefined;
  return call?.data.entities.create ?? [];
}

/** The whole `data` payload of the last snapshot.create. */
function createdData(): Record<string, unknown> {
  const call = vi.mocked(prisma.snapshot.create).mock.calls.at(-1)?.[0] as
    | { data: Record<string, unknown> }
    | undefined;
  return call?.data ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.snapshot.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.snapshot.create).mockResolvedValue({ id: "snap-1" } as never);
});

// ─── gltf-scene ───────────────────────────────────────────────────────────────

describe("gltfSceneHandler.ingest", () => {
  const base = { repoId: "repo-1", label: null, gitCommitSha: null };

  it("ingests binary .glb bytes into the real entity tree", async () => {
    const id = await gltfSceneHandler.ingest({
      ...base, sourceFile: "robot.glb", bytes: toGlb(gltfJson()),
    });
    expect(id).toBe("snap-1");

    const entities = createdEntities();
    expect(entities.map((e) => e.name)).toEqual(["Arm", "Grip"]);
    expect(entities.map((e) => e.path)).toEqual(["arm", "arm.grip"]);
    // Parenting survives the binary decode, not just the node count.
    expect(entities[0]!.parentEntityId).toBeNull();
    expect(entities[1]!.parentEntityId).toBe("arm");
    expect(entities[0]!.kind).toBe("assembly");
    expect(entities[1]!.kind).toBe("part");
    // Positions come through as numbers, not mangled bytes.
    expect([entities[0]!.posX, entities[0]!.posY, entities[0]!.posZ]).toEqual([1, 2, 3]);
    expect([entities[1]!.posX, entities[1]!.posY, entities[1]!.posZ]).toEqual([0, 0, 4]);
  });

  it("ingests .gltf JSON to exactly the same tree as the .glb", async () => {
    await gltfSceneHandler.ingest({ ...base, sourceFile: "robot.gltf", bytes: Buffer.from(gltfJson(), "utf8") });
    const fromJson = createdEntities();

    vi.mocked(prisma.snapshot.create).mockClear();
    await gltfSceneHandler.ingest({ ...base, sourceFile: "robot.glb", bytes: toGlb(gltfJson()) });
    expect(createdEntities()).toEqual(fromJson);
  });

  it("records the handler id, source file and label on the snapshot", async () => {
    await gltfSceneHandler.ingest({
      repoId: "repo-1", sourceFile: "robot.glb", bytes: toGlb(gltfJson()),
      label: "Add grip", gitCommitSha: "abc123",
    });
    expect(createdData()).toMatchObject({
      repoId: "repo-1", handlerId: "gltf-scene", sourceFile: "robot.glb",
      label: "Add grip", gitCommitSha: "abc123",
    });
  });

  it("reuses an existing snapshot for the same commit + file", async () => {
    vi.mocked(prisma.snapshot.findFirst).mockResolvedValue({ id: "snap-existing" } as never);
    const id = await gltfSceneHandler.ingest({
      repoId: "repo-1", sourceFile: "robot.glb", bytes: toGlb(gltfJson()),
      label: null, gitCommitSha: "abc123",
    });
    expect(id).toBe("snap-existing");
    expect(vi.mocked(prisma.snapshot.create)).not.toHaveBeenCalled();
  });

  it("throws on a GLB whose JSON chunk is malformed", async () => {
    const broken = toGlb("{ not json");
    await expect(gltfSceneHandler.ingest({ ...base, sourceFile: "x.glb", bytes: broken }))
      .rejects.toThrow(/Invalid glTF/);
    expect(vi.mocked(prisma.snapshot.create)).not.toHaveBeenCalled();
  });

  it("throws on arbitrary binary bytes that are neither GLB nor JSON", async () => {
    const junk = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0xfe, 0x01]);
    await expect(gltfSceneHandler.ingest({ ...base, sourceFile: "x.glb", bytes: junk }))
      .rejects.toThrow(/Invalid glTF/);
  });
});

// ─── plain-text (unchanged behaviour, byte-typed input) ───────────────────────

describe("plainTextHandler.ingest", () => {
  const base = { repoId: "repo-1", label: null, gitCommitSha: null };

  it("decodes bytes as UTF-8 into snapshotBody, entities empty", async () => {
    const text = "hello\nworld — ünïcode\n";
    const id = await plainTextHandler.ingest({ ...base, sourceFile: "notes.md", bytes: Buffer.from(text, "utf8") });
    expect(id).toBe("snap-1");
    expect(createdData()).toMatchObject({ handlerId: "plain-text", snapshotBody: text });
    expect(createdEntities()).toEqual([]);
  });

  it("still rejects payloads over the size cap", async () => {
    const big = Buffer.alloc(PLAIN_TEXT_MAX_BYTES + 1, 0x61);
    await expect(plainTextHandler.ingest({ ...base, sourceFile: "big.txt", bytes: big }))
      .rejects.toThrow(/exceeds/);
    expect(vi.mocked(prisma.snapshot.create)).not.toHaveBeenCalled();
  });
});

// ─── design ingest wrapper ────────────────────────────────────────────────────

describe("ingestDesignSnapshot", () => {
  it("ingests a binary .glb design into a snapshot with an entity tree", async () => {
    const id = await ingestDesignSnapshot({ repoId: "repo-1", name: "robot.glb", buffer: toGlb(gltfJson()) });
    expect(id).toBe("snap-1");
    expect(createdEntities().map((e) => e.name)).toEqual(["Arm", "Grip"]);
  });

  it("passes the design bytes through untouched (no UTF-8 round-trip)", async () => {
    const glb = toGlb(gltfJson());
    await ingestDesignSnapshot({ repoId: "repo-1", name: "robot.glb", buffer: glb });
    // A lossy string round-trip would have replaced bytes and failed the parse.
    expect(vi.mocked(prisma.snapshot.create)).toHaveBeenCalledTimes(1);
  });

  it("degrades to null (no throw) on malformed bytes", async () => {
    const junk = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0xde, 0xad, 0xbe, 0xef]);
    await expect(ingestDesignSnapshot({ repoId: "repo-1", name: "robot.glb", buffer: junk }))
      .resolves.toBeNull();
  });

  it("returns null for a format no handler claims", async () => {
    await expect(ingestDesignSnapshot({ repoId: "repo-1", name: "part.step", buffer: Buffer.from("x") }))
      .resolves.toBeNull();
    expect(vi.mocked(prisma.snapshot.create)).not.toHaveBeenCalled();
  });
});
