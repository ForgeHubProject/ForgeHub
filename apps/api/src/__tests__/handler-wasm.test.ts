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

// FHR republishes a rolling release at the same wasm URL and stamps the new
// build in the manifest, so the cache and the browser must follow the build.
describe("GET /handlers/:build/:asset — follows the manifest build", () => {
  const withBuild = (build: string) => MANIFEST.replace("e520cc6", build);

  it("refetches the same upstream URL once the manifest names a new build", async () => {
    const fetchMock = stubUpstream();
    await app.inject({ method: "GET", url: "/handlers/e520cc6/gltf-scene" });
    await app.inject({ method: "GET", url: "/handlers/e520cc6/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    __setManifestForTests(withBuild("a1b2c3d"));
    await app.inject({ method: "GET", url: "/handlers/a1b2c3d/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
  });

  it("a new build also invalidates the unversioned URL's cache", async () => {
    const fetchMock = stubUpstream();
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    __setManifestForTests(withBuild("a1b2c3d"));
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets the browser keep a matching build for an hour", async () => {
    stubUpstream();
    const res = await app.inject({ method: "GET", url: "/handlers/e520cc6/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("serves the current wasm for a stale build URL but forbids the browser to keep it", async () => {
    stubUpstream();
    __setManifestForTests(withBuild("a1b2c3d"));
    const res = await app.inject({ method: "GET", url: "/handlers/e520cc6/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload).toEqual(Buffer.from(WASM_BYTES));
  });

  it("400s on an invalid asset under a build", async () => {
    const res = await app.inject({ method: "GET", url: "/handlers/e520cc6/..%2fetc" });
    expect(res.statusCode).toBe(400);
  });

  it("leaves a handler with no stamped build on the TTL alone", async () => {
    __setManifestForTests(MANIFEST.replace(', build = "e520cc6"', ""));
    const fetchMock = stubUpstream();
    const res = await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /handlers/:asset — fhr-wasm-1 first (FHR SPEC §7)", () => {
  const BOTH = MANIFEST.replace(
    `"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"`,
    `"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"
"wasm-fhr1" = "https://cdn.test/fhr/forge-handler-gltf-scene.fhr1.wasm"`,
  );
  // Each upstream answers with its own URL as the body, so the test sees which was served.
  function stubByUrl(missing: string[] = []) {
    const fn = vi.fn(async (url: string) =>
      missing.includes(url) ? new Response("Not Found", { status: 404 }) : new Response(url, { status: 200 }),
    );
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("serves the fhr-wasm-1 module when the manifest lists one, and says which", async () => {
    __setManifestForTests(BOTH);
    stubByUrl();
    const res = await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.fhr1.wasm");
    expect(res.headers["x-fhr-wasm-abi"]).toBe("fhr-wasm-1");
  });

  it("serves the Go build while the module isn't published yet", async () => {
    __setManifestForTests(BOTH);
    stubByUrl(["https://cdn.test/fhr/forge-handler-gltf-scene.fhr1.wasm"]);
    const res = await app.inject({ method: "GET", url: "/handlers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe("https://cdn.test/fhr/forge-handler-gltf-scene.wasm");
    expect(res.headers["x-fhr-wasm-abi"]).toBe("go-js");
  });
});
