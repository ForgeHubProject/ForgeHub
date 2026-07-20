/**
 * Renderer-bundle proxy tests. Where each bundle lives comes from the FHR
 * manifest (stubbed here via the test hook, so the manifest itself never hits
 * the network); the upstream *bundle* fetch is stubbed too. We assert the
 * bundle is re-served with a JS MIME type (so a browser can `import()` it), that
 * a bare id, a full filename, and a lazy `-3d` chunk sibling all resolve to the
 * manifest URL's directory, and that bad ids / unknown renderers are handled.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers/server.js";
import { __clearRendererCache } from "../routes/renderers.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";

// The manifest keys a renderer bundle by handler id; its URL fixes the base
// directory the proxy resolves siblings against.
const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }

[assets.handlers."gltf-scene"]
"wasm" = "https://cdn.test/fhr/forge-handler-gltf-scene.wasm"

[assets.renderers]
"gltf-scene" = "https://cdn.test/fhr/renderer-gltf-scene.js"
`;

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
  __clearRendererCache();
  __setManifestForTests(MANIFEST);
  globalThis.fetch = realFetch;
});

describe("GET /renderers/:asset", () => {
  it("resolves a bare handler id to the manifest renderer URL and serves JS", async () => {
    const fetchMock = vi.fn(async () => new Response("export default { mount(){} };", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toContain("export default");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://cdn.test/fhr/renderer-gltf-scene.js");
  });

  it("accepts a trailing .js in the id", async () => {
    globalThis.fetch = vi.fn(async () => new Response("export default {};", { status: 200 })) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/gltf-scene.js" });
    expect(res.statusCode).toBe(200);
  });

  it("resolves a full renderer filename to the manifest URL's directory", async () => {
    const fetchMock = vi.fn(async () => new Response("export default { mount(){} };", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/renderer-gltf-scene.js" });
    expect(res.statusCode).toBe(200);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://cdn.test/fhr/renderer-gltf-scene.js");
  });

  it("resolves a lazy 3D chunk sibling next to its manifest renderer", async () => {
    // A lite bundle dynamic-imports its 3D chunk as a sibling by full filename.
    // The proxy must fetch that name from the manifest renderer's directory, not
    // re-prefix it to renderer-renderer-gltf-scene-3d.js (the bug that 404'd it).
    const fetchMock = vi.fn(async () => new Response("export default { mount3d(){} };", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await app.inject({ method: "GET", url: "/renderers/renderer-gltf-scene-3d.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    const requestedUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(requestedUrl).toBe("https://cdn.test/fhr/renderer-gltf-scene-3d.js");
    expect(requestedUrl).not.toContain("renderer-renderer-");
  });

  it("404s for a renderer the manifest doesn't know (never fetched upstream)", async () => {
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/nonexistent" });
    expect(res.statusCode).toBe(404);
    // resolution fails before any upstream fetch is attempted
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the upstream has the sibling name but no such bundle", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/renderer-gltf-scene-missing.js" });
    expect(res.statusCode).toBe(404);
  });

  it("400s on an invalid handler id", async () => {
    const res = await app.inject({ method: "GET", url: "/renderers/..%2fetc" });
    expect(res.statusCode).toBe(400);
  });

  it("caches the bundle (upstream fetched once across two requests)", async () => {
    const fetchMock = vi.fn(async () => new Response("export default {};", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
