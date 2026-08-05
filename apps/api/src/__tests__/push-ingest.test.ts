import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Push-time ingestion reads each matched blob as BYTES. A UTF-8 decode here
// used to mangle binary containers (.glb) before the handler could decode them,
// so a pushed .glb landed with no entity tree.

vi.mock("../prisma.js", () => ({
  prisma: {
    snapshot: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { ingestCommitRange } from "../ingest.js";

const execFile = promisify(execFileCb);
const NULL_SHA = "0".repeat(40);

/** glTF JSON for a single named node at a translation. */
function gltfJson(name: string, translation: [number, number, number]): Buffer {
  return Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], name: "Scene" }],
    nodes: [{ name, translation }],
  }), "utf8");
}

/** The same scene packed as a binary GLB (12-byte header + one JSON chunk). */
function glb(name: string, translation: [number, number, number]): Buffer {
  const jsonBytes = gltfJson(name, translation);
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const chunkData = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(chunkData.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunkHeader.length + chunkData.length, 8);
  return Buffer.concat([header, chunkHeader, chunkData]);
}

let repoPath: string;

/** A repo opted into .glb/.gltf/.txt, with one commit holding `files`. */
async function seedRepo(files: Record<string, Buffer>): Promise<string> {
  await execFile("git", ["init", "-q", "-b", "main", repoPath]);
  await execFile("git", ["config", "user.email", "t@example.test"], { cwd: repoPath });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await mkdir(join(repoPath, ".forge"), { recursive: true });
  await writeFile(join(repoPath, ".forge/formats"), ".glb\n.gltf\n.txt\n", "utf8");
  for (const [name, buf] of Object.entries(files)) {
    await writeFile(join(repoPath, name), buf);
  }
  await execFile("git", ["add", "-A"], { cwd: repoPath });
  await execFile("git", ["commit", "-q", "-m", "Add parts"], { cwd: repoPath });
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  return stdout.trim();
}

type EntityRow = { name: string; path: string; posX: number | null; posY: number | null; posZ: number | null };

/** Entity rows written for a given source file, across all snapshot.create calls. */
function entitiesFor(sourceFile: string): EntityRow[] {
  const call = vi.mocked(prisma.snapshot.create).mock.calls.find(
    (c) => (c[0] as { data: { sourceFile: string } }).data.sourceFile === sourceFile,
  );
  return call
    ? (call[0] as { data: { entities: { create: EntityRow[] } } }).data.entities.create
    : [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(prisma.snapshot.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.snapshot.create).mockResolvedValue({ id: "snap-1" } as never);
  repoPath = await mkdtemp(join(tmpdir(), "fh-push-ingest-"));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("ingestCommitRange", () => {
  it("ingests a pushed binary .glb into an entity tree", async () => {
    const sha = await seedRepo({ "housing.glb": glb("Housing", [4, 0, -2]) });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);

    const entities = entitiesFor("housing.glb");
    expect(entities.map((e) => e.name)).toEqual(["Housing"]);
    expect([entities[0]!.posX, entities[0]!.posY, entities[0]!.posZ]).toEqual([4, 0, -2]);
  });

  it("gives a pushed .glb and its .gltf twin the same entity tree", async () => {
    const sha = await seedRepo({
      "housing.glb": glb("Housing", [4, 0, -2]),
      "housing.gltf": gltfJson("Housing", [4, 0, -2]),
    });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);
    expect(entitiesFor("housing.glb")).toEqual(entitiesFor("housing.gltf"));
  });

  it("still ingests text files as text", async () => {
    const sha = await seedRepo({ "notes.txt": Buffer.from("line one\nline two\n", "utf8") });
    await ingestCommitRange("repo-1", repoPath, NULL_SHA, sha);

    const call = vi.mocked(prisma.snapshot.create).mock.calls.find(
      (c) => (c[0] as { data: { sourceFile: string } }).data.sourceFile === "notes.txt",
    );
    expect((call![0] as { data: { snapshotBody: string; handlerId: string } }).data).toMatchObject({
      handlerId: "plain-text",
      snapshotBody: "line one\nline two\n",
    });
  });

  it("skips a file the handler cannot decode without failing the push", async () => {
    const sha = await seedRepo({ "broken.glb": Buffer.from([0x67, 0x6c, 0x54, 0x46, 0xde, 0xad, 0xbe, 0xef]) });
    await expect(ingestCommitRange("repo-1", repoPath, NULL_SHA, sha)).resolves.toBeUndefined();
    expect(entitiesFor("broken.glb")).toEqual([]);
  });
});
