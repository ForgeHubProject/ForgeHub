/**
 * Renderer-bundle proxy tests. Where each bundle lives comes from the FHR
 * manifest (stubbed here via the test hook, so the manifest itself never hits
 * the network); the upstream *bundle* fetch is stubbed too. We assert the
 * bundle is re-served with a JS MIME type (so a browser can `import()` it), that
 * a bare id, a full filename, and a lazy `-3d` chunk sibling all resolve to the
 * manifest URL's directory, and that bad ids / unknown renderers are handled.
 * The cache follows the manifest's build: a new build refetches at once, the
 * same build is served from memory, and `/renderers/<build>/<asset>` (the URL
 * the web app uses to bust the browser's cache) behaves the same way.
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
    const versioned = await app.inject({ method: "GET", url: "/renderers/e520cc6/..%2fetc" });
    expect(versioned.statusCode).toBe(400);
  });

  it("caches the bundle (upstream fetched once across two requests)", async () => {
    const fetchMock = vi.fn(async () => new Response("export default {};", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a miss is retried once its short TTL lapses — one failure must not 404 for an hour", async () => {
    // First request: upstream down → 404, and the miss is cached.
    let up = false;
    const fetchMock = vi.fn(async () =>
      up ? new Response("export default {};", { status: 200 }) : new Response("nope", { status: 500 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const miss = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(miss.statusCode).toBe(404);

    // Within the miss TTL the cached failure answers — upstream is not hammered.
    up = true;
    const still = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(still.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the miss TTL the fetch is retried and recovers. (The success TTL is
    // an hour — the old behavior cached the FAILURE that long too, which turned
    // one transient upstream error into an hour-long outage.)
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const recovered = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
      expect(recovered.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The manifest above with the handler's build swapped — what the 5-minute
// manifest refresh installs after FHR republishes a rolling release at the
// SAME renderer URL.
const manifestAt = (build: string) => MANIFEST.replace('build = "e520cc6"', `build = "${build}"`);

/** An upstream whose bundle body is whatever `body.current` says at fetch time. */
function upstream(body: { current: string }) {
  return vi.fn(async () => new Response(body.current, { status: 200 }));
}

describe("renderer cache follows the manifest build", () => {
  it("refetches as soon as the manifest names a new build (same URL upstream)", async () => {
    const body = { current: "export default 'old';" };
    const fetchMock = upstream(body);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("export default 'old';");

    // FHR republishes renderer-gltf-scene.js in place and stamps a new build.
    body.current = "export default 'new';";
    __setManifestForTests(manifestAt("6b5162d"));

    const second = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(second.body).toBe("export default 'new';");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe("https://cdn.test/fhr/renderer-gltf-scene.js");
  });

  it("serves the same build from memory, by bare id and by versioned URL alike", async () => {
    const fetchMock = upstream({ current: "export default {};" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await app.inject({ method: "GET", url: "/renderers/e520cc6/gltf-scene" });
    await app.inject({ method: "GET", url: "/renderers/e520cc6/gltf-scene" });
    await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a versioned URL naming the current build may be cached by the browser", async () => {
    globalThis.fetch = upstream({ current: "export default {};" }) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/e520cc6/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("a versioned URL naming another build gets the current bundle, not kept by the browser", async () => {
    // A tab that read the build before the manifest moved: the server can only
    // serve what the manifest names now, and the browser must not file it under
    // the old build's URL for an hour.
    const body = { current: "export default 'new';" };
    globalThis.fetch = upstream(body) as unknown as typeof fetch;
    __setManifestForTests(manifestAt("6b5162d"));

    const res = await app.inject({ method: "GET", url: "/renderers/e520cc6/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("export default 'new';");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the lazy 3D chunk keeps the build in its path and follows its handler's build", async () => {
    // The lite bundle at /renderers/<build>/gltf-scene imports its chunk as
    // /renderers/<build>/renderer-gltf-scene-3d.js (file name swapped in place).
    const body = { current: "export const v = 'old';" };
    const fetchMock = upstream(body);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await app.inject({ method: "GET", url: "/renderers/e520cc6/renderer-gltf-scene-3d.js" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=3600");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://cdn.test/fhr/renderer-gltf-scene-3d.js");

    body.current = "export const v = 'new';";
    __setManifestForTests(manifestAt("6b5162d"));
    const second = await app.inject({ method: "GET", url: "/renderers/6b5162d/renderer-gltf-scene-3d.js" });
    expect(second.body).toBe("export const v = 'new';");
    expect(second.headers["cache-control"]).toBe("public, max-age=3600");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a cached miss does not outlive its build", async () => {
    // Upstream down under the old build → a cached 404 (short miss TTL). A new
    // build is a new bundle: it is fetched right away, not after the miss TTL.
    let up = false;
    const fetchMock = vi.fn(async () =>
      up ? new Response("export default {};", { status: 200 }) : new Response("nope", { status: 500 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect((await app.inject({ method: "GET", url: "/renderers/gltf-scene" })).statusCode).toBe(404);

    up = true;
    __setManifestForTests(manifestAt("6b5162d"));
    const res = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
