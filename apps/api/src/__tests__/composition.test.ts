import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { buildComposition, getComposition, __resetCompositionCache } from "../composition.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";
import type { BlobSize } from "../git-utils.js";

const blob = (path: string, size: number): BlobSize => ({ path, size });
const seg = (segments: ReturnType<typeof buildComposition>["segments"], format: string) =>
  segments.find((s) => s.format === format);

describe("buildComposition (byte-share math)", () => {
  it("bins by extension and computes byte-share percentages", () => {
    const { totalBytes, totalFiles, segments } = buildComposition(
      [blob("a.ts", 100), blob("b.ts", 100), blob("readme.md", 100)],
      new Set(),
      new Map(),
    );
    expect(totalBytes).toBe(300);
    expect(totalFiles).toBe(3);
    // Sorted by bytes desc: TypeScript (200) then Markdown (100).
    expect(segments.map((s) => s.format)).toEqual([".ts", ".md"]);
    expect(seg(segments, ".ts")).toMatchObject({ label: "TypeScript", bytes: 200, fileCount: 2, pct: 66.7, optedIn: false });
    expect(seg(segments, ".md")).toMatchObject({ label: "Markdown", bytes: 100, pct: 33.3 });
  });

  it("groups opted-in official formats by their handler domain and flags optedIn", () => {
    const { segments } = buildComposition(
      [blob("scene/a.gltf", 400), blob("scene/b.glb", 200), blob("data.csv", 200), blob("notes.md", 100)],
      new Set([".gltf", ".glb"]),
      new Map([[".gltf", "gltf-scene"], [".glb", "gltf-scene"]]),
    );
    const gltf = seg(segments, "gltf-scene");
    expect(gltf).toMatchObject({ label: "glTF scene", bytes: 600, fileCount: 2, optedIn: true });
    expect(gltf!.pct).toBeCloseTo(66.7, 1);
    // Non-opted formats keep their extension identity, unmarked.
    expect(seg(segments, ".csv")).toMatchObject({ label: "CSV", bytes: 200, optedIn: false });
  });

  it("still flags opted-in even when the manifest has no handler for the format", () => {
    const { segments } = buildComposition([blob("part.stl", 100)], new Set([".stl"]), new Map());
    expect(seg(segments, ".stl")).toMatchObject({ label: "STL", bytes: 100, optedIn: true });
  });

  it("folds the long tail into Other but never an opted-in segment", () => {
    const blobs: BlobSize[] = [blob("app.ts", 1000), blob("tiny.gltf", 5)];
    for (let i = 0; i < 12; i++) blobs.push(blob(`f${i}.ext${i}`, 5)); // 12 sub-1% extensions
    const { segments } = buildComposition(blobs, new Set([".gltf"]), new Map([[".gltf", "gltf-scene"]]));

    expect(seg(segments, ".ts")).toBeTruthy();
    // The opted-in .gltf survives despite being well under 1%.
    expect(seg(segments, "gltf-scene")).toMatchObject({ optedIn: true, bytes: 5 });
    // The 12 tiny non-opted extensions collapse into one Other slice.
    const other = seg(segments, "other");
    expect(other).toMatchObject({ label: "Other", bytes: 60, optedIn: false });
    expect(segments.filter((s) => s.format.startsWith(".ext")).length).toBe(0);
  });

  it("handles an empty tree", () => {
    expect(buildComposition([], new Set(), new Map())).toEqual({ totalBytes: 0, totalFiles: 0, segments: [] });
  });
});

describe("getComposition (real tree + manifest)", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("test/composition.git");
    __resetCompositionCache();
    __setManifestForTests(`
[formats]
".gltf" = { handler = "gltf-scene", build = "abc" }
`);
  }, 30_000);

  afterAll(async () => {
    __resetManifest();
    await repo.cleanup();
  });

  it("computes byte-share over a real tree, labeling the opted-in .gltf by domain", async () => {
    await makeCommit(
      repo.workDir,
      {
        ".forge/formats": ".gltf\n", // 6 bytes, no extension → folds into Other
        "scene/model.gltf": "G".repeat(400),
        "data/table.csv": "C".repeat(200),
        "README.md": "M".repeat(100),
      },
      "seed a mixed tree",
    );

    const comp = await getComposition(repo.storageKey);
    expect(comp).not.toBeNull();
    expect(comp!.totalFiles).toBe(4);
    expect(comp!.totalBytes).toBe(706); // 400 + 200 + 100 + 6

    const gltf = comp!.segments.find((s) => s.format === "gltf-scene");
    expect(gltf).toMatchObject({ label: "glTF scene", bytes: 400, fileCount: 1, optedIn: true });
    expect(gltf!.pct).toBeCloseTo(56.7, 1);

    expect(comp!.segments.find((s) => s.format === ".csv")).toMatchObject({ bytes: 200, optedIn: false });
    expect(comp!.segments.find((s) => s.format === ".md")).toMatchObject({ bytes: 100, optedIn: false });
    // The percentages sum to ~100.
    const sum = comp!.segments.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });

  it("returns an empty composition for an unknown ref", async () => {
    expect(await getComposition(repo.storageKey, "does-not-exist")).toBeNull();
  });
});
