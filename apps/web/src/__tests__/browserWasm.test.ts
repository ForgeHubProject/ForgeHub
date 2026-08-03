/**
 * Tier-B (wasm-in-browser) compute path tests. The wasm module boundary is
 * mocked the way official-handlers tests mock the server's — via injected
 * deps (fetchImpl + instantiate) — so no real wasm build or network is
 * involved; what's under test is the load/memoize/parse contract.
 *
 * instantiateOnPage gets its own block further down, with the Go runtime,
 * WebAssembly.instantiate and the global scope injected rather than the whole
 * function stubbed out — otherwise the module's most novel code (the
 * `__forgeHandler*` global discovery) is executed by nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetBrowserHandlers,
  browserWasmDiff,
  instantiateOnPage,
  loadBrowserHandler,
  parseDiffOutput,
  type BrowserWasmDeps,
  type PageInstantiateDeps,
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

/**
 * The page-instantiation half, previously covered by nothing because every case
 * above injects `instantiate`. The Go runtime, WebAssembly.instantiate and the
 * global scope are injected here instead, so the interesting part — discovering
 * the `__forgeHandler*` global the build registers, and only the NEW one — runs
 * for real.
 */
describe("instantiateOnPage", () => {
  function pageDeps(
    scope: Record<string, unknown>,
    onRun: () => void,
  ): PageInstantiateDeps {
    return {
      loadGoRuntime: async () => {
        scope["Go"] = class {
          importObject = {} as WebAssembly.Imports;
          async run() {
            // A real handler registers its api synchronously, then parks.
            onRun();
            return new Promise<void>(() => {});
          }
        };
      },
      instantiateWasm: async () => ({ instance: {} as WebAssembly.Instance }),
      scope,
    };
  }

  it("returns the diff api the build registers on the page", async () => {
    const scope: Record<string, unknown> = {};
    const api = { diff: () => RAW_DIFF };
    const handler = await instantiateOnPage(
      new ArrayBuffer(8),
      "gltf-scene",
      pageDeps(scope, () => void (scope["__forgeHandlerGltfScene"] = api)),
    );
    expect(handler).toBe(api);
  });

  it("ignores a handler global that was already on the page", async () => {
    const stale = { diff: () => '{"changes":[{"path":"stale"}]}' };
    const fresh = { diff: () => RAW_DIFF };
    const scope: Record<string, unknown> = { __forgeHandlerStale: stale };
    const handler = await instantiateOnPage(
      new ArrayBuffer(8),
      "gltf-scene",
      pageDeps(scope, () => void (scope["__forgeHandlerFresh"] = fresh)),
    );
    expect(handler).toBe(fresh);
  });

  it("throws when the Go runtime failed to load", async () => {
    const scope: Record<string, unknown> = {};
    await expect(
      instantiateOnPage(new ArrayBuffer(8), "gltf-scene", {
        loadGoRuntime: async () => {},
        instantiateWasm: async () => ({ instance: {} as WebAssembly.Instance }),
        scope,
      }),
    ).rejects.toThrow("Go runtime failed to load");
  });

  it("throws when the build registers no diff() global", async () => {
    const scope: Record<string, unknown> = {};
    await expect(
      instantiateOnPage(
        new ArrayBuffer(8),
        "gltf-scene",
        pageDeps(scope, () => void (scope["__forgeHandlerBroken"] = { render: () => "" })),
      ),
    ).rejects.toThrow("registered no diff() global");
  });

  it("propagates an instantiation failure (bad wasm bytes)", async () => {
    const scope: Record<string, unknown> = {};
    const d = pageDeps(scope, () => {});
    await expect(
      instantiateOnPage(new ArrayBuffer(8), "gltf-scene", {
        ...d,
        instantiateWasm: async () => {
          throw new Error("CompileError: invalid wasm");
        },
      }),
    ).rejects.toThrow("invalid wasm");
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
