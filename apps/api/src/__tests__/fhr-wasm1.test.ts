import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { instantiateWasmHandler } from "../fhr/wasm-runtime.js";
import { officialWasmDiff, __resetOfficialHandlers, type OfficialHandlerDeps } from "../fhr/official-handlers.js";
import { __setManifestForTests, __resetManifest, parseManifest } from "../fhr/manifest.js";
import { wasmCandidates } from "../fhr/wasm-assets.js";

// fhr-wasm-1 (FHR SPEC §7) through the REAL worker (wasm-worker.cjs and its
// host, fhr-wasm1.cjs): the module is test-data/fhr-wasm-1/fixture.wasm, a
// small Rust handler whose answers are fixed functions of its inputs' lengths
// and which writes to stderr and draws randomness through the sandboxed WASI.

const fixture = readFileSync(fileURLToPath(new URL("../../../../test-data/fhr-wasm-1/fixture.wasm", import.meta.url)));

describe("an fhr-wasm-1 module in the worker", () => {
  it("diffs, reading its capabilities and contract from the module", async () => {
    const lines: string[] = [];
    const h = await instantiateWasmHandler(fixture, "fixture", { onLog: (l) => lines.push(l) });
    expect(h.abi).toBe("fhr-wasm-1");
    expect(h.semanticMerge).toBe(true);
    expect(h.previewType).toBe("model/gltf-binary");
    const d = await h.diff(Buffer.from("abc"), Buffer.from("abcdef"));
    expect(d).toEqual({
      version: "1.0",
      format: "fixture",
      changes: [{ path: "bytes", kind: "modified", label: "bytes", before: "3", after: "6" }],
    });
    // Its stderr line arrived through the sandbox's fd_write, after random_get.
    expect(lines).toEqual(["fixture: diff 3+6 bytes"]);
    h.retire?.();
  });

  it("merges, the blob arriving raw beside the conflicts", async () => {
    const h = await instantiateWasmHandler(fixture, "fixture", { onLog: () => {} });
    const m = await h.merge!(Buffer.from("b"), Buffer.from("ours"), Buffer.from("theirs!"));
    expect(m.blob.toString()).toBe("ourstheirs!");
    expect(m.conflicts).toEqual([{ path: "bytes", ours: 4, theirs: 7 }]);
    h.retire?.();
  });

  it("previews, the bytes intact both ways", async () => {
    const h = await instantiateWasmHandler(fixture, "fixture", { onLog: () => {} });
    const input = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const p = await h.preview!(input);
    expect(p.mediaType).toBe("model/gltf-binary");
    expect([...p.bytes]).toEqual([...input].reverse());
    h.retire?.();
  });

  it("takes inputs larger than any JSON or base64 path would like", async () => {
    const h = await instantiateWasmHandler(fixture, "fixture", { onLog: () => {} });
    const big = Buffer.alloc(12 << 20, 7);
    const d = await h.diff(big, Buffer.alloc(0));
    expect(d.changes[0]).toMatchObject({ before: String(12 << 20), after: "0" });
    h.retire?.();
  });

  it("answers a crashed call with an error, then starts a fresh instance", async () => {
    const h = await instantiateWasmHandler(fixture, "fixture", { onLog: () => {} });
    // The fixture traps (an unreachable instruction) on a head of "trap".
    await expect(h.diff(Buffer.from("x"), Buffer.from("trap"))).rejects.toThrow(/wasm fixture: .*unreachable/);
    // The crashed instance is gone; the next call gets a fresh one.
    await expect(h.diff(Buffer.from("a"), Buffer.from("a"))).resolves.toMatchObject({ changes: [] });
    h.retire?.();
  });
});

const MANIFEST = (assets: string) => `
[formats]
".fx" = { handler = "fixture", build = "b1" }

[assets.handlers."fixture"]
${assets}
`;

const GO_URL = "https://example.test/fhr/forge-handler-fixture.wasm";
const FHR1_URL = "https://example.test/fhr/forge-handler-fixture.fhr1.wasm";

describe("choosing the build", () => {
  beforeEach(() => __resetOfficialHandlers());
  afterEach(() => {
    __resetManifest();
    vi.unstubAllEnvs();
  });

  it("parses both assets from the manifest", () => {
    const m = parseManifest(MANIFEST(`"wasm" = "${GO_URL}"\n"wasm-fhr1" = "${FHR1_URL}"`));
    expect(m.wasmUrls.get("fixture")).toBe(GO_URL);
    expect(m.wasmFhr1Urls.get("fixture")).toBe(FHR1_URL);
  });

  it("prefers fhr-wasm-1, keeps the Go build as the fallback, and FHR_WASM_ABI=go-js opts out", async () => {
    __setManifestForTests(MANIFEST(`"wasm" = "${GO_URL}"\n"wasm-fhr1" = "${FHR1_URL}"`));
    expect(await wasmCandidates("fixture")).toEqual([
      { abi: "fhr-wasm-1", url: FHR1_URL },
      { abi: "go-js", url: GO_URL },
    ]);
    vi.stubEnv("FHR_WASM_ABI", "go-js");
    expect(await wasmCandidates("fixture")).toEqual([{ abi: "go-js", url: GO_URL }]);
  });

  it("follows the release layout under the self-hosting override", async () => {
    vi.stubEnv("FHR_WASM_BASE", "https://mirror.test/fhr");
    expect((await wasmCandidates("png")).map((c) => c.url)).toEqual([
      "https://mirror.test/fhr/forge-handler-png.fhr1.wasm",
      "https://mirror.test/fhr/forge-handler-png.wasm",
    ]);
  });

  // Each fetched "build" is its own URL's bytes, so a diff can say which one ran.
  const deps = (status: Record<string, number>, instantiate: (bytes: Buffer) => Promise<unknown>): OfficialHandlerDeps => ({
    fetchImpl: vi.fn(async (url: string) => new Response(new TextEncoder().encode(url), { status: status[url] ?? 200 })) as unknown as typeof fetch,
    instantiate: instantiate as unknown as OfficialHandlerDeps["instantiate"],
  });
  const fx = new Set([".fx"]);
  const diffOf = (tag: string) => ({ version: "1.0", format: "fixture", changes: [{ path: tag, kind: "modified" as const }] });

  it("runs the fhr-wasm-1 module when the manifest lists one", async () => {
    __setManifestForTests(MANIFEST(`"wasm" = "${GO_URL}"\n"wasm-fhr1" = "${FHR1_URL}"`));
    const instantiate = vi.fn(async (bytes: Buffer) => ({ diff: async () => diffOf(bytes.toString()) }));
    const res = await officialWasmDiff("a.fx", fx, Buffer.from("a"), Buffer.from("b"), deps({}, instantiate));
    expect(res?.diff.changes[0]?.path).toBe(FHR1_URL);
  });

  it("falls back to the Go build while the module isn't published yet", async () => {
    __setManifestForTests(MANIFEST(`"wasm" = "${GO_URL}"\n"wasm-fhr1" = "${FHR1_URL}"`));
    const instantiate = vi.fn(async (bytes: Buffer) => ({ diff: async () => diffOf(bytes.toString()) }));
    const res = await officialWasmDiff("a.fx", fx, Buffer.from("a"), Buffer.from("b"), deps({ [FHR1_URL]: 404 }, instantiate));
    expect(res?.diff.changes[0]?.path).toBe(GO_URL);
  });

  it("falls back to the Go build when the module won't start", async () => {
    __setManifestForTests(MANIFEST(`"wasm" = "${GO_URL}"\n"wasm-fhr1" = "${FHR1_URL}"`));
    const instantiate = vi.fn(async (bytes: Buffer) => {
      if (bytes.toString() === FHR1_URL) throw new Error("init: bad module");
      return { diff: async () => diffOf(bytes.toString()) };
    });
    const res = await officialWasmDiff("a.fx", fx, Buffer.from("a"), Buffer.from("b"), deps({}, instantiate));
    expect(res?.diff.changes[0]?.path).toBe(GO_URL);
  });

  it("runs a handler that ships only the fhr-wasm-1 module", async () => {
    __setManifestForTests(MANIFEST(`"wasm-fhr1" = "${FHR1_URL}"`));
    const instantiate = vi.fn(async (bytes: Buffer) => ({ diff: async () => diffOf(bytes.toString()) }));
    const res = await officialWasmDiff("a.fx", fx, Buffer.from("a"), Buffer.from("b"), deps({}, instantiate));
    expect(res?.diff.changes[0]?.path).toBe(FHR1_URL);
  });
});
