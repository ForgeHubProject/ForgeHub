import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Push-time ingestion records the scene entities of the files a push changed,
// for entity search. The file's official FHR handler reads it (#74): ForgeHub
// diffs it against an empty file, and what the handler lists as added is the
// file's nodes, meshes and materials (fhr-entities.ts).

vi.mock("../prisma.js", () => ({
  prisma: {
    snapshot: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

// A stand-in official handler: "reads" a file whose bytes are JSON naming its
// nodes (with parents), meshes and materials, and answers the way the FHR scene
// diff does for an added file.
const officialDiffs: Array<{ filePath: string; head: Buffer }> = [];
vi.mock("../fhr/official-handlers.js", () => ({
  officialHandlerId: vi.fn(async (ext: string) =>
    ({ ".glb": "gltf-scene", ".gltf": "gltf-scene", ".obj": "obj", ".ipynb": "ipynb" } as Record<string, string>)[ext] ?? null),
  officialWasmDiff: vi.fn(async (filePath: string, _exts: Set<string>, _base: Buffer, head: Buffer) => {
    officialDiffs.push({ filePath, head });
    let scene: { nodes?: Array<[string, string?]>; meshes?: string[]; materials?: string[]; cells?: string[] };
    try {
      scene = JSON.parse(head.toString("utf8"));
    } catch {
      return null; // the handler could not read it
    }
    const group = (name: string, members: unknown[]) => ({ path: name, kind: "modified", label: name, children: members });
    const changes = [];
    if (scene.nodes) changes.push(group("nodes", scene.nodes.map(([n, parent]) => ({
      path: `nodes/${encodeURIComponent(n)}`, kind: "added", label: n,
      children: parent ? [{ path: `nodes/${n}/parent`, kind: "added", label: "parent", after: parent }] : [],
    }))));
    if (scene.meshes) changes.push(group("meshes", scene.meshes.map((m) => ({ path: `meshes/${m}`, kind: "added", label: m }))));
    if (scene.materials) changes.push(group("materials", scene.materials.map((m) => ({ path: `materials/${m}`, kind: "added", label: m }))));
    if (scene.cells) changes.push(group("cells", scene.cells.map((c) => ({ path: `cells/${c}`, kind: "added", label: c }))));
    return { diff: { version: "1.0", format: "x", changes }, handlerId: filePath.endsWith(".obj") ? "obj" : "gltf-scene" };
  }),
}));

import { prisma } from "../prisma.js";
import { ingestCommitRange } from "../ingest.js";
import { entitiesFromDiff, MAX_ENTITIES_PER_FILE } from "../fhr-entities.js";

const execFile = promisify(execFileCb);
const NULL_SHA = "0".repeat(40);

let repoPath: string;

const scene = (s: object) => Buffer.from(JSON.stringify(s), "utf8");

async function init(formats: string): Promise<void> {
  await execFile("git", ["init", "-q", "-b", "main", repoPath]);
  await execFile("git", ["config", "user.email", "t@example.test"], { cwd: repoPath });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await mkdir(join(repoPath, ".forge"), { recursive: true });
  await writeFile(join(repoPath, ".forge/formats"), formats, "utf8");
}

/** Write `files` (null deletes) and commit; returns the commit SHA. */
async function commit(files: Record<string, Buffer | null>, message = "change"): Promise<string> {
  for (const [name, buf] of Object.entries(files)) {
    if (buf === null) await rm(join(repoPath, name));
    else await writeFile(join(repoPath, name), buf);
  }
  await execFile("git", ["add", "-A"], { cwd: repoPath });
  await execFile("git", ["commit", "-q", "-m", message], { cwd: repoPath });
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  return stdout.trim();
}

type Created = { data: { sourceFile: string; handlerId: string; gitCommitSha: string; label: string; entities: { create: Array<{ kind: string; name: string; path: string; parentEntityId: string | null }> } } };
const created = (): Created["data"][] =>
  vi.mocked(prisma.snapshot.create).mock.calls.map((c) => (c[0] as Created).data);

beforeEach(async () => {
  vi.clearAllMocks();
  officialDiffs.length = 0;
  vi.mocked(prisma.snapshot.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.snapshot.create).mockResolvedValue({ id: "snap-1" } as never);
  repoPath = await mkdtemp(join(tmpdir(), "fh-push-ingest-"));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("ingestCommitRange", () => {
  it("records a pushed scene's nodes, meshes and materials as its official handler reads them", async () => {
    await init(".glb\n");
    const sha = await commit({
      "car.glb": scene({ nodes: [["Body"], ["Wheel_FL", "Body"]], meshes: ["BodyMesh"], materials: ["Paint"] }),
    }, "Add the car");
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);

    const [snap] = created();
    expect(snap).toMatchObject({ sourceFile: "car.glb", handlerId: "gltf-scene", gitCommitSha: sha, label: "Add the car" });
    expect(snap!.entities.create).toEqual([
      { entityId: "nodes/Body", parentEntityId: null, kind: "node", name: "Body", path: "nodes/Body" },
      { entityId: "nodes/Wheel_FL", parentEntityId: "nodes/Body", kind: "node", name: "Wheel_FL", path: "nodes/Wheel_FL" },
      { entityId: "meshes/BodyMesh", parentEntityId: null, kind: "mesh", name: "BodyMesh", path: "meshes/BodyMesh" },
      { entityId: "materials/Paint", parentEntityId: null, kind: "material", name: "Paint", path: "materials/Paint" },
    ]);
  });

  it("hands the handler the blob's bytes untouched", async () => {
    await init(".glb\n");
    const bytes = scene({ nodes: [["Ünïcödé"]] });
    const sha = await commit({ "part.glb": bytes });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);
    expect(officialDiffs[0]!.head.equals(bytes)).toBe(true);
    expect(created()[0]!.entities.create[0]!.name).toBe("Ünïcödé");
  });

  it("reads only the files each commit changed, not every file at every commit", async () => {
    await init(".glb\n.obj\n");
    const first = await commit({ "a.glb": scene({ nodes: [["A"]] }), "b.obj": scene({ nodes: [["B"]] }) });
    const second = await commit({ "a.glb": scene({ nodes: [["A2"]] }) });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, second);
    expect(created().map((s) => `${s.sourceFile}@${s.gitCommitSha === first ? 1 : 2}`)).toEqual(["a.glb@1", "b.obj@1", "a.glb@2"]);
    expect(created()[1]!.handlerId).toBe("obj");
  });

  it("skips a deleted file, a format not opted in, and one no official handler reads", async () => {
    await init(".glb\n.txt\n");
    await commit({ "gone.glb": scene({ nodes: [["G"]] }) });
    const sha = await commit({
      "gone.glb": null,
      "model.obj": scene({ nodes: [["NotOptedIn"]] }),
      "notes.txt": Buffer.from("plain text"),
    });
    const before = (await execFile("git", ["rev-parse", "HEAD~1"], { cwd: repoPath })).stdout.trim();
    await ingestCommitRange("repo-1", repoPath, before, sha);
    expect(officialDiffs).toEqual([]);
    expect(created()).toEqual([]);
  });

  it("records nothing for a file with no scene in it", async () => {
    await init(".ipynb\n");
    const sha = await commit({ "analysis.ipynb": scene({ cells: ["intro", "plot"] }) });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);
    expect(officialDiffs).toHaveLength(1);
    expect(created()).toEqual([]);
  });

  it("skips a file the handler cannot read without failing the push", async () => {
    await init(".glb\n");
    const sha = await commit({
      "broken.glb": Buffer.from([0x67, 0x6c, 0x54, 0x46, 0xde, 0xad, 0xbe, 0xef]),
      "fine.glb": scene({ nodes: [["Fine"]] }),
    });
    await expect(ingestCommitRange("repo-1", repoPath, NULL_SHA, sha)).resolves.toBeUndefined();
    expect(created().map((s) => s.sourceFile)).toEqual(["fine.glb"]);
  });
});

describe("entitiesFromDiff", () => {
  it("ignores what isn't scene structure, and decodes an escaped name without a label", () => {
    const out = entitiesFromDiff([
      { path: "nodes", kind: "modified", children: [{ path: "nodes/Arm%2FLeft", kind: "added" }] },
      { path: "animations", kind: "modified", children: [{ path: "animations/Spin", kind: "added", label: "Spin" }] },
    ]);
    expect(out).toEqual([{ entityId: "nodes/Arm%2FLeft", parentEntityId: null, kind: "node", name: "Arm/Left", path: "nodes/Arm%2FLeft" }]);
  });

  it("is bounded, so a pathological scene can't flood the table", () => {
    const children = Array.from({ length: MAX_ENTITIES_PER_FILE + 10 }, (_, i) => ({ path: `nodes/n${i}`, kind: "added" as const, label: `n${i}` }));
    expect(entitiesFromDiff([{ path: "nodes", kind: "modified", children }])).toHaveLength(MAX_ENTITIES_PER_FILE);
  });
});
