/**
 * Merge-diff engine routing tests for resolve-pull (#74 slice 2).
 *
 * materializeResolvedFiles needs a diff of the two branch blobs to map the
 * user's field-level picks onto entities. That diff must come from the official
 * FHR wasm handler — the same engine that produced the diff the resolver UI
 * displayed — never from the built-in TS duplicate. When the official engine
 * can't run, the resolution must fail loudly rather than recompute with a
 * different engine whose answer could silently disagree with the user's picks.
 *
 * Uses a real bare git repo with two branches; prisma is mocked for the
 * branch-tip snapshot lookups and the wasm compute is mocked (officialWasmDiff)
 * so routing is asserted deterministically without a real wasm build.
 * materializeGltfMerge itself runs for real — its semantics are covered by
 * gltf-merge-pipeline.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    snapshot: { findFirst: vi.fn() },
  },
}));

vi.mock("../fhr/official-handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fhr/official-handlers.js")>();
  return { ...actual, officialWasmDiff: vi.fn() };
});

import type { Entity } from "@prisma/client";
import { prisma } from "../prisma.js";
import { officialWasmDiff } from "../fhr/official-handlers.js";
import { gltfSceneHandler } from "../handlers/gltf-scene/handler.js";
import { parseGltf, type GltfDocument } from "../gltf-parser.js";
import { materializeResolvedFiles } from "../merge/resolve-pull.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDoc(nodes: NonNullable<GltfDocument["nodes"]>): GltfDocument {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ name: "Scene", nodes: [0] }],
    nodes,
  };
}

// Base: Assembly → Part A (at [0,0,0]); incoming: Part A moved to [5,0,0].
const BASE_DOC = makeDoc([
  { name: "Assembly", children: [1] },
  { name: "Part A", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);
const INCOMING_DOC = makeDoc([
  { name: "Assembly", children: [1] },
  { name: "Part A", translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
]);

/** Convert a ParsedEntity into an Entity row as Prisma would store it. */
function toEntityRow(e: ReturnType<typeof parseGltf>[number], snapshotId: string): Entity {
  return {
    id: `row-${snapshotId}-${e.entityId}`,
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

// The StructuredDiff the mocked wasm engine returns for BASE vs INCOMING —
// same wire shape the official handler emits (payloads carry entityId, field
// changes as children).
const WASM_DIFF = {
  diff: {
    version: "1.0" as const,
    format: "gltf-scene",
    changes: [
      {
        path: "assembly.part-a",
        kind: "modified" as const,
        label: "Part A",
        before: { entityId: "assembly.part-a" },
        after: { entityId: "assembly.part-a" },
        children: [
          { path: "position", kind: "modified" as const, before: [0, 0, 0], after: [5, 0, 0] },
        ],
      },
    ],
  },
  handlerId: "gltf-scene",
};

let repo: TestRepo;
let mainSha: string;
let featureSha: string;

beforeAll(async () => {
  repo = await createTestRepo("test/resolve-pull-diff.git");
  mainSha = await makeCommit(
    repo.workDir,
    { ".forge/formats": ".gltf\n", "scene.gltf": JSON.stringify(BASE_DOC) },
    "base scene",
    "main",
  );
  featureSha = await makeCommit(
    repo.workDir,
    { "scene.gltf": JSON.stringify(INCOMING_DOC) },
    "move Part A",
    "feature",
  );
}, 30_000);

afterAll(async () => {
  await repo.cleanup();
});

beforeEach(() => {
  vi.mocked(officialWasmDiff).mockReset().mockResolvedValue(WASM_DIFF);
  const baseSnap = {
    id: "snap-base",
    handlerId: "gltf-scene",
    snapshotBody: null,
    entities: parseGltf(BASE_DOC).map((e) => toEntityRow(e, "snap-base")),
  };
  const incSnap = {
    id: "snap-inc",
    handlerId: "gltf-scene",
    snapshotBody: null,
    entities: parseGltf(INCOMING_DOC).map((e) => toEntityRow(e, "snap-inc")),
  };
  vi.mocked(prisma.snapshot.findFirst).mockImplementation((async (args: {
    where?: { gitCommitSha?: string };
  }) => {
    if (args?.where?.gitCommitSha === mainSha) return baseSnap;
    if (args?.where?.gitCommitSha === featureSha) return incSnap;
    return null;
  }) as never);
});

function resolveWithFields(fields: Array<{ entityId: string; field: string; side: "base" | "incoming" }>) {
  return materializeResolvedFiles(
    "repo-1",
    repo.storageKey,
    "main",
    "feature",
    [{ sourceFile: "scene.gltf", fields }],
  );
}

describe("materializeResolvedFiles — official wasm merge diff", () => {
  it("routes the merge diff through the official wasm handler, not the built-in", async () => {
    const builtInDiff = vi.spyOn(gltfSceneHandler, "diff");
    const out = await resolveWithFields([]);

    expect(officialWasmDiff).toHaveBeenCalledTimes(1);
    const [filePath, activeExts, baseBuf, headBuf] = vi.mocked(officialWasmDiff).mock.calls[0]!;
    expect(filePath).toBe("scene.gltf");
    expect(activeExts.has(".gltf")).toBe(true);
    expect(baseBuf.toString("utf8")).toBe(JSON.stringify(BASE_DOC));
    expect(headBuf.toString("utf8")).toBe(JSON.stringify(INCOMING_DOC));
    expect(builtInDiff).not.toHaveBeenCalled();

    // Default side is incoming → Part A carries the incoming translation.
    const doc = JSON.parse(out["scene.gltf"]!) as GltfDocument;
    expect(doc.nodes![1]!.translation).toEqual([5, 0, 0]);
  });

  it("applies a base-side field pick using the wasm diff's field-change map", async () => {
    const out = await resolveWithFields([
      { entityId: "assembly.part-a", field: "position", side: "base" },
    ]);
    const doc = JSON.parse(out["scene.gltf"]!) as GltfDocument;
    expect(doc.nodes![1]!.translation).toEqual([0, 0, 0]);
  });

  it("fails loudly when the official wasm handler is unavailable — no substitute engine", async () => {
    vi.mocked(officialWasmDiff).mockResolvedValue(null);
    const builtInDiff = vi.spyOn(gltfSceneHandler, "diff");
    await expect(resolveWithFields([])).rejects.toThrow(/Official FHR handler unavailable/);
    expect(builtInDiff).not.toHaveBeenCalled();
  });
});
