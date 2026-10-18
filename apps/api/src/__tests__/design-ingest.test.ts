/**
 * A design version is read by its format's official FHR handler (#74): the
 * snapshot that records it carries its scene entities (for search) and, by
 * existing, marks the version as semantically comparable. Images stay visual.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: { snapshot: { findFirst: vi.fn(), create: vi.fn() } },
}));

const read: string[] = [];
vi.mock("../fhr/official-handlers.js", () => ({
  officialHandlerId: vi.fn(async (ext: string) =>
    ({ ".glb": "gltf-scene", ".ipynb": "ipynb", ".png": "png" } as Record<string, string>)[ext] ?? null),
  officialWasmDiff: vi.fn(async (path: string, _exts: Set<string>, _base: Buffer, head: Buffer) => {
    // Like the real one: no official handler for the extension, no diff.
    if (![".glb", ".ipynb", ".png"].some((e) => path.endsWith(e))) return null;
    read.push(path);
    if (head.toString("utf8") === "junk") return null;
    const changes = path.endsWith(".glb")
      ? [{ path: "nodes", kind: "modified", children: [{ path: "nodes/Arm", kind: "added", label: "Arm" }] }]
      : [{ path: "cells", kind: "modified", children: [{ path: "cells/intro", kind: "added", label: "intro" }] }];
    return { diff: { version: "1.0", format: "x", changes }, handlerId: path.endsWith(".glb") ? "gltf-scene" : "ipynb" };
  }),
}));

import { prisma } from "../prisma.js";
import { designIsSemantic, ingestDesignSnapshot } from "../design-ingest.js";

type Created = { data: { handlerId: string; gitCommitSha: string | null; entities: { create: Array<{ kind: string; name: string }> } } };
const created = () => vi.mocked(prisma.snapshot.create).mock.calls.map((c) => (c[0] as Created).data);

beforeEach(() => {
  vi.clearAllMocks();
  read.length = 0;
  vi.mocked(prisma.snapshot.create).mockResolvedValue({ id: "snap-1" } as never);
});

describe("ingestDesignSnapshot", () => {
  it("records a 3D design's scene as its official handler reads it", async () => {
    await expect(ingestDesignSnapshot({ repoId: "r", name: "robot.glb", buffer: Buffer.from("glTF…") })).resolves.toBe("snap-1");
    expect(created()[0]).toMatchObject({ handlerId: "gltf-scene", gitCommitSha: null });
    expect(created()[0]!.entities.create).toEqual([expect.objectContaining({ kind: "node", name: "Arm" })]);
  });

  it("still records a design whose format has no scene, so it compares semantically", async () => {
    await expect(ingestDesignSnapshot({ repoId: "r", name: "analysis.ipynb", buffer: Buffer.from("{}") })).resolves.toBe("snap-1");
    expect(created()[0]!.entities.create).toEqual([]);
  });

  it("is null, without throwing, when the handler can't read the bytes", async () => {
    await expect(ingestDesignSnapshot({ repoId: "r", name: "robot.glb", buffer: Buffer.from("junk") })).resolves.toBeNull();
    expect(created()).toEqual([]);
  });

  it("is null for a format no official handler reads, and for an image", async () => {
    await expect(ingestDesignSnapshot({ repoId: "r", name: "part.step", buffer: Buffer.from("x") })).resolves.toBeNull();
    await expect(ingestDesignSnapshot({ repoId: "r", name: "mockup.png", buffer: Buffer.from("x") })).resolves.toBeNull();
    expect(read).toEqual([]);
  });
});

describe("designIsSemantic", () => {
  it("is true where an official handler reads the format, except for images", async () => {
    expect(await designIsSemantic("robot.glb")).toBe(true);
    expect(await designIsSemantic("analysis.ipynb")).toBe(true);
    expect(await designIsSemantic("mockup.png")).toBe(false);
    expect(await designIsSemantic("part.step")).toBe(false);
  });
});
