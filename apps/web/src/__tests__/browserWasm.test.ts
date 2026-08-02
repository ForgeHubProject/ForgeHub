/**
 * Tier-B (wasm-in-browser) compute path tests. The wasm module boundary is
 * mocked the way official-handlers tests mock the server's — via injected
 * deps (fetchImpl + instantiate) — so no real wasm build or network is
 * involved; what's under test is the load/memoize/parse contract.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetBrowserHandlers,
  browserWasmDiff,
  loadBrowserHandler,
  parseDiffOutput,
  type BrowserWasmDeps,
} from "../lib/browserWasm";
import { API_BASE } from "../api";

const RAW_DIFF = JSON.stringify({
  format: "gltf-scene",
  changes: [{ path: "nodes/0", kind: "modified", label: "Cube" }],
});

function deps(over: Partial<BrowserWasmDeps> = {}): BrowserWasmDeps {
  return {
    fetchImpl: vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as unknown as typeof fetch,
    instantiate: vi.fn(async () => ({ diff: () => RAW_DIFF })),
    ...over,
  };
}

beforeEach(() => __resetBrowserHandlers());

describe("loadBrowserHandler", () => {
  it("fetches the build through the API's /handlers proxy (official-only source)", async () => {
    const d = deps();
    await loadBrowserHandler("gltf-scene", d);
    expect(d.fetchImpl).toHaveBeenCalledWith(`${API_BASE}/handlers/gltf-scene`);
    expect(d.instantiate).toHaveBeenCalledTimes(1);
  });

  it("memoizes the instance across loads", async () => {
    const d = deps();
    const a = await loadBrowserHandler("gltf-scene", d);
    const b = await loadBrowserHandler("gltf-scene", d);
    expect(a).toBe(b);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
    expect(d.instantiate).toHaveBeenCalledTimes(1);
  });

  it("rejects when the proxy has no build, and does NOT memoize the failure", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 404 }));
    const d = deps({ fetchImpl: failing as unknown as typeof fetch });
    await expect(loadBrowserHandler("gltf-scene", d)).rejects.toThrow("HTTP 404");

    // a later attempt retries instead of replaying the cached rejection
    const ok = deps();
    await expect(loadBrowserHandler("gltf-scene", ok)).resolves.toBeDefined();
    expect(ok.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects when instantiation fails (bad wasm), allowing a retry", async () => {
    const d = deps({ instantiate: vi.fn(async () => { throw new Error("invalid wasm"); }) });
    await expect(loadBrowserHandler("gltf-scene", d)).rejects.toThrow("invalid wasm");
    const ok = deps();
    await expect(loadBrowserHandler("gltf-scene", ok)).resolves.toBeDefined();
  });
});

describe("browserWasmDiff", () => {
  it("runs the handler and returns the parsed structured diff", async () => {
    const result = await browserWasmDiff("gltf-scene", new Uint8Array([1]), new Uint8Array([2]), deps());
    expect(result.format).toBe("gltf-scene");
    expect(result.version).toBe("1.0");
    expect(result.changes).toEqual([{ path: "nodes/0", kind: "modified", label: "Cube" }]);
  });

  it("hands the exact blob bytes to the handler", async () => {
    const diffFn = vi.fn(() => RAW_DIFF);
    const d = deps({ instantiate: vi.fn(async () => ({ diff: diffFn })) });
    const base = new Uint8Array([1, 2, 3]);
    const head = new Uint8Array([4, 5]);
    await browserWasmDiff("gltf-scene", base, head, d);
    expect(diffFn).toHaveBeenCalledWith(base, head);
  });

  it("surfaces a handler-reported error as a rejection", async () => {
    const d = deps({ instantiate: vi.fn(async () => ({ diff: () => '{"error":"bad gltf"}' })) });
    await expect(browserWasmDiff("gltf-scene", new Uint8Array(), new Uint8Array(), d))
      .rejects.toThrow("bad gltf");
  });
});

describe("parseDiffOutput (same contract as the server runtime)", () => {
  it("wraps changes with the wire version and defaults format to the handler id", () => {
    expect(parseDiffOutput('{"changes":[]}', "gltf-scene")).toEqual({
      version: "1.0",
      format: "gltf-scene",
      changes: [],
    });
  });

  it("prefers the handler's own format name", () => {
    expect(parseDiffOutput(RAW_DIFF, "other").format).toBe("gltf-scene");
  });

  it("defaults missing changes to an empty list", () => {
    expect(parseDiffOutput("{}", "gltf-scene").changes).toEqual([]);
  });

  it("throws on unparseable output", () => {
    expect(() => parseDiffOutput("not json", "gltf-scene")).toThrow("unparseable");
  });

  it("throws on an error payload", () => {
    expect(() => parseDiffOutput('{"error":"boom"}', "gltf-scene")).toThrow("boom");
  });
});
