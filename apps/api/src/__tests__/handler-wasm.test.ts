/**
 * Handler-wasm proxy tests (Tier B, issue #66 P4). Where each wasm build lives
 * comes from the FHR manifest (stubbed via the test hook, so the manifest never
 * hits the network); the upstream *wasm* fetch is stubbed too. We assert the
 * build is re-served same-origin as application/wasm, that a bare id and the
 * full release filename both resolve to the manifest URL, that bad ids /
 * unknown handlers are handled without touching upstream, and that the cache
 * an unauthenticated caller can write to stays bounded.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers/server.js";
import { __clearHandlerWasmCache } from "../routes/handler-wasm.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";

const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

// Recognizable wasm-ish bytes so we can assert the body round-trips verbatim.
const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function stubUpstream(status = 200) {
  const fn = vi.fn(async () =>
    status === 200
      ? new Response(WASM_BYTES.buffer.slice(0), { status: 200 })
      : new Response("Not Found", { status }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  app = await createTestServer();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  __resetManifest();
  await app.close();
});

beforeEach(() => {
  __clearHandlerWasmCache();
  __setManifestForTests(MANIFEST);
  globalThis.fetch = realFetch;
});

describe("GET /handlers/:asset", () => {
  it("resolves a bare handler id to the manifest wasm URL and serves application/wasm", async () => {
    const fetchMock = stubUpstream();
    const res = await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/wasm");
    expect(res.rawPayload).toEqual(Buffer.from(WASM_BYTES));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
  });

  it("accepts the full release filename", async () => {
    const fetchMock = stubUpstream();
    const res = await app.inject({ method: "GET", url: "/handlers/forge-handler-gltf-scene.wasm" });
    expect(res.statusCode).toBe(200);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
  });

  it("404s for a handler the manifest declares no wasm build for (never fetches upstream)", async () => {
    const fetchMock = stubUpstream();
    const res = await app.inject({ method: "GET", url: "/handlers/nonexistent" });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the upstream build is missing", async () => {
    stubUpstream(404);
    const res = await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(res.statusCode).toBe(404);
  });

  it("400s on an invalid handler id", async () => {
    const res = await app.inject({ method: "GET", url: "/handlers/..%2fetc" });
    expect(res.statusCode).toBe(400);
  });

  it("caches the build (upstream fetched once across two requests)", async () => {
    const fetchMock = stubUpstream();
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression: the cache is keyed by unauthenticated caller input and holds
  // whole wasm binaries, so it must be bounded rather than grow forever.
  it("bounds the cache — unknown ids evict rather than accumulate", async () => {
    const fetchMock = stubUpstream();
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Enough distinct ids to push the real build past the bound.
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: `/handlers/filler${i}` });
      expect(res.statusCode).toBe(404);
    }
    // Evicted, so this re-fetches instead of being served from a cache that
    // never gave the entry up.
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an over-long handler id before it can become a cache key", async () => {
    const res = await app.inject({ method: "GET", url: `/handlers/${"a".repeat(80)}` });
    expect(res.statusCode).toBe(400);
  });
});
