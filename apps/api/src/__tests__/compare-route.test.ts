/**
 * Snapshot-compare endpoint tests, focused on engine routing (#74 slice 2).
 *
 * The blob fast-path must go through the official FHR wasm handler for any
 * extension the manifest maps to an official handler — never the built-in TS
 * duplicate. The built-in registry still serves formats FHR does not publish
 * (the plain-text catch-all), and the snapshot-based fallback still serves
 * already-ingested data when the official engine can't run.
 *
 * Uses a real bare git repo with committed blobs and a .forge/formats opt-in;
 * prisma is mocked (repo visibility, snapshots, diff cache). The manifest is
 * stubbed via its test hook and the wasm compute itself is mocked
 * (officialWasmDiff) so routing is asserted deterministically without a real
 * wasm build — the same setup as filediff.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    repoCollaborator: { findUnique: vi.fn() },
    snapshot: { findFirst: vi.fn() },
    diffCache: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

// Keep the real (manifest-driven) officialHandlerId for engine selection; mock
// only the wasm compute so tests don't depend on a real wasm build.
vi.mock("../fhr/official-handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fhr/official-handlers.js")>();
  return { ...actual, officialWasmDiff: vi.fn() };
});

import type { FastifyInstance } from "fastify";
import type { Entity } from "@prisma/client";
import { prisma } from "../prisma.js";
import { officialWasmDiff } from "../fhr/official-handlers.js";
import { gltfSceneHandler } from "../handlers/gltf-scene/handler.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { createTestServer } from "./helpers/server.js";

// ".gltf" → gltf-scene, official per the (stubbed) manifest. ".txt" is
// deliberately absent: it is the built-in plain-text catch-all, not an
// FHR-published format.
const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }
".glb"  = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"
`;

// A manifest that is perfectly reachable but does not map ".gltf" — a
// partially-updated, re-keyed, forked or self-hosted (FHR_MANIFEST_URL)
// registry. officialHandlerId returns null here (no throw), so this is a
// distinct trigger from the manifest-outage case above.
const MANIFEST_WITHOUT_GLTF = `
[formats]
".foo" = { handler = "foo-thing", build = "e520cc6" }

[assets.handlers."foo-thing"]
"wasm" = "https://cdn.test/fhr/forge-handler-foo-thing.wasm"
`;

// A deterministic StructuredDiff the mocked wasm engine returns. The label is
// distinct from anything the built-in engine would emit, so a response carrying
// it proves which engine ran.
const WASM_DIFF = {
  diff: {
    version: "1.0" as const,
    format: "gltf-scene",
    changes: [{ path: "assembly/gear", kind: "modified" as const, label: "Gear (official wasm)" }],
  },
  handlerId: "gltf-scene",
};

const gltf = (x: number) =>
  JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Gear", translation: [x, 0, 0] }],
  });

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: "ent-id",
    snapshotId: "snap-1",
    entityId: "gear",
    parentEntityId: null,
    kind: "part",
    name: "Gear",
    path: "gear",
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

let repo: TestRepo;
let app: FastifyInstance;
let baseSha: string;
let headSha: string;

const MOCK_REPO = {
  id: "repo-1",
  name: "scene",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "" as string,
  collaborators: [],
} as const;

// Snapshot fixtures the mocked prisma serves for both the fast-path lookup
// (select shape) and the fallback lookup (include entities).
type SnapFixture = {
  id: string;
  handlerId: string;
  gitCommitSha: string | null;
  sourceFile: string;
  snapshotBody: string | null;
  entities: Entity[];
};

let snapshots: Record<string, SnapFixture>;

function installSnapshots(fixtures: SnapFixture[]) {
  snapshots = Object.fromEntries(fixtures.map((s) => [s.id, s]));
  vi.mocked(prisma.snapshot.findFirst).mockImplementation((async (args: { where?: { id?: string } }) => {
    return snapshots[args?.where?.id ?? ""] ?? null;
  }) as never);
}

beforeAll(async () => {
  repo = await createTestRepo("test/compare-route.git");
  baseSha = await makeCommit(
    repo.workDir,
    { ".forge/formats": ".gltf\n.txt\n", "model.gltf": gltf(0), "notes.txt": "alpha\nbeta\n" },
    "init scene",
  );
  headSha = await makeCommit(
    repo.workDir,
    { "model.gltf": gltf(5), "notes.txt": "alpha\ngamma\n" },
    "move gear, edit notes",
  );
  (MOCK_REPO as { storageKey: string }).storageKey = repo.storageKey;
  __setManifestForTests(MANIFEST);
  app = await createTestServer();
}, 30_000);

afterAll(async () => {
  __resetManifest();
  await repo.cleanup();
  await app.close();
});

beforeEach(() => {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(prisma.diffCache.findUnique).mockReset().mockResolvedValue(null);
  vi.mocked(prisma.diffCache.create).mockReset().mockResolvedValue({} as never);
  vi.mocked(officialWasmDiff).mockReset().mockResolvedValue(WASM_DIFF);
  __setManifestForTests(MANIFEST);
  installSnapshots([
    {
      id: "snap-base",
      handlerId: "gltf-scene",
      gitCommitSha: baseSha,
      sourceFile: "model.gltf",
      snapshotBody: null,
      entities: [makeEntity({ snapshotId: "snap-base", name: "Gear" })],
    },
    {
      id: "snap-target",
      handlerId: "gltf-scene",
      gitCommitSha: headSha,
      sourceFile: "model.gltf",
      snapshotBody: null,
      entities: [makeEntity({ snapshotId: "snap-target", name: "Gear Renamed" })],
    },
    {
      id: "snap-txt-base",
      handlerId: "plain-text",
      gitCommitSha: baseSha,
      sourceFile: "notes.txt",
      snapshotBody: null,
      entities: [],
    },
    {
      id: "snap-txt-target",
      handlerId: "plain-text",
      gitCommitSha: headSha,
      sourceFile: "notes.txt",
      snapshotBody: null,
      entities: [],
    },
  ]);
});

function get(query: string) {
  return app.inject({ method: "GET", url: `/repos/alice/scene/compare?${query}` });
}

describe("GET /repos/:handle/:name/compare — official wasm fast path", () => {
  it("routes a glTF blob diff through the official wasm handler, not the built-in", async () => {
    const res = await get("base=snap-base&target=snap-target");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("gltf-scene");
    expect(body.baseSnapshotId).toBe("snap-base");
    expect(body.targetSnapshotId).toBe("snap-target");
    // The deterministic label proves the official engine's answer was served.
    expect(JSON.stringify(body.changes)).toContain("Gear (official wasm)");
    expect(officialWasmDiff).toHaveBeenCalledTimes(1);
    const [filePath, activeExts, baseBuf, headBuf] = vi.mocked(officialWasmDiff).mock.calls[0]!;
    expect(filePath).toBe("model.gltf");
    expect(activeExts.has(".gltf")).toBe(true);
    expect(baseBuf.toString("utf8")).toBe(gltf(0));
    expect(headBuf.toString("utf8")).toBe(gltf(5));
  });

  it("caches the wasm result under the official handler id", async () => {
    await get("base=snap-base&target=snap-target");
    expect(prisma.diffCache.create).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.diffCache.create).mock.calls[0]![0] as {
      data: { handlerId: string; result: string };
    };
    expect(arg.data.handlerId).toBe("gltf-scene");
    expect(arg.data.result).toContain("Gear (official wasm)");
  });

  it("serves a cached diff without invoking the wasm engine", async () => {
    vi.mocked(prisma.diffCache.findUnique).mockResolvedValue({
      result: JSON.stringify(WASM_DIFF.diff),
    } as never);
    const res = await get("base=snap-base&target=snap-target");
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json().changes)).toContain("Gear (official wasm)");
    expect(officialWasmDiff).not.toHaveBeenCalled();
    expect(prisma.diffCache.create).not.toHaveBeenCalled();
  });

  it("falls back to the snapshot compare when the official wasm handler is unavailable", async () => {
    vi.mocked(officialWasmDiff).mockResolvedValue(null);
    const res = await get("base=snap-base&target=snap-target");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Served from the already-ingested Entity rows (name change → modified),
    // not from a substitute blob engine.
    expect(body.format).toBe("gltf-scene");
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].kind).toBe("modified");
    expect(body.changes[0].children.some((c: { path: string }) => c.path === "name")).toBe(true);
    expect(prisma.diffCache.create).not.toHaveBeenCalled();
  });

  it("503s when the manifest is unreachable — never substitutes the built-in engine (#74)", async () => {
    // A cold-start manifest fetch failure is NOT "this extension has no official
    // handler": we cannot tell which engine is authoritative, so answering with
    // the built-in blob engine would be exactly the substitution /filediff was
    // changed to refuse in slice 1.
    const builtInDiff = vi.spyOn(gltfSceneHandler, "diff");
    __resetManifest();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("manifest unreachable")));
    try {
      const res = await get("base=snap-base&target=snap-target");
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain("Official FHR handler unavailable");
      expect(builtInDiff).not.toHaveBeenCalled();
      expect(officialWasmDiff).not.toHaveBeenCalled();
      // Nothing may enter the shared DiffCache namespace on this path.
      expect(prisma.diffCache.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      builtInDiff.mockRestore();
    }
  });

  it("never substitutes the built-in blob engine when the manifest does not map the extension (#74)", async () => {
    // The manifest is reachable and simply has no entry for ".gltf", so
    // officialHandlerId returns null rather than throwing. That must not hand
    // the blob to the built-in gltf-scene handler, whose output would land in
    // the very DiffCache namespace the wasm path reads back.
    const builtInDiff = vi.spyOn(gltfSceneHandler, "diff");
    __setManifestForTests(MANIFEST_WITHOUT_GLTF);
    try {
      const res = await get("base=snap-base&target=snap-target");
      expect(res.statusCode).toBe(200);
      expect(builtInDiff).not.toHaveBeenCalled();
      expect(prisma.diffCache.create).not.toHaveBeenCalled();
      // Served by the snapshot fallback over ingested Entity rows (the name
      // change), not by a substitute blob engine.
      const body = res.json();
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0].children.some((c: { path: string }) => c.path === "name")).toBe(true);
    } finally {
      builtInDiff.mockRestore();
    }
  });

  it("agrees with /filediff about a file the manifest does not map", async () => {
    // Same repo, same commit, same file: /filediff refuses it outright and
    // compare must not answer it with the built-in blob engine either. Compare
    // still serves its pre-existing snapshot fallback — what the two endpoints
    // agree on is the engine, and that nothing enters the shared DiffCache.
    const builtInDiff = vi.spyOn(gltfSceneHandler, "diff");
    __setManifestForTests(MANIFEST_WITHOUT_GLTF);
    try {
      const fileDiff = await app.inject({
        method: "GET",
        url: `/repos/alice/scene/filediff?path=model.gltf&sha=${headSha}`,
      });
      expect(fileDiff.statusCode).toBe(404);
      expect(fileDiff.json().error).toBe("No semantic handler for this file");

      const compare = await get("base=snap-base&target=snap-target");
      expect(compare.statusCode).toBe(200);
      expect(compare.json().format).toBe("gltf-scene");

      expect(builtInDiff).not.toHaveBeenCalled();
      expect(officialWasmDiff).not.toHaveBeenCalled();
      expect(prisma.diffCache.create).not.toHaveBeenCalled();
    } finally {
      builtInDiff.mockRestore();
    }
  });

  it("keeps the DiffCache read key and write key identical", async () => {
    // The row a request writes must be findable by the lookup the next request
    // performs. Selection settles on "gltf-scene"; an engine that reports a
    // different id must not produce a row under a key no reader looks up (a
    // permanent miss that re-runs the wasm on every request, silently).
    vi.mocked(officialWasmDiff).mockResolvedValue({ ...WASM_DIFF, handlerId: "gltf-scene@wasm" });
    await get("base=snap-base&target=snap-target");
    const readKey = (vi.mocked(prisma.diffCache.findUnique).mock.calls[0]![0] as {
      where: { handlerId_baseBlobSha_headBlobSha: { handlerId: string } };
    }).where.handlerId_baseBlobSha_headBlobSha.handlerId;
    for (const call of vi.mocked(prisma.diffCache.create).mock.calls) {
      expect((call[0] as { data: { handlerId: string } }).data.handlerId).toBe(readKey);
    }
  });

  it("caches under the engine id when it agrees with selection", async () => {
    await get("base=snap-base&target=snap-target");
    expect(prisma.diffCache.create).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.diffCache.create).mock.calls[0]![0] as { data: { handlerId: string } };
    expect(arg.data.handlerId).toBe("gltf-scene");
  });

  it("still serves plain-text (non-FHR format) via the built-in catch-all fast path", async () => {
    const res = await get("base=snap-txt-base&target=snap-txt-target");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("text");
    expect(Array.isArray(body.lines)).toBe(true);
    expect(JSON.stringify(body.changes)).toContain("gamma");
    // ".txt" resolves to no official handler, so the wasm engine is never asked.
    expect(officialWasmDiff).not.toHaveBeenCalled();
  });
});
