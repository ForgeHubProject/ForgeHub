/**
 * Renderer-bundle proxy tests. The upstream fetch is stubbed so no network is
 * used; we assert the bundle is re-served with a JS MIME type (so a browser can
 * `import()` it) and that bad ids / missing bundles are handled.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers/server.js";
import { __clearRendererCache } from "../routes/renderers.js";

let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  app = await createTestServer();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

beforeEach(() => {
  __clearRendererCache();
  globalThis.fetch = realFetch;
});

describe("GET /renderers/:handlerId", () => {
  it("proxies the bundle and serves it with a JS MIME type", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("export default { mount(){} };", { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await app.inject({ method: "GET", url: "/renderers/gltf-scene" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toContain("export default");
  });

  it("accepts a trailing .js in the id", async () => {
    globalThis.fetch = vi.fn(async () => new Response("export default {};", { status: 200 })) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/gltf-scene.js" });
    expect(res.statusCode).toBe(200);
  });

  it("404s when the upstream has no such bundle", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/renderers/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("400s on an invalid handler id", async () => {
    const res = await app.inject({ method: "GET", url: "/renderers/..%2fetc" });
    expect(res.statusCode).toBe(400);
  });

  it("caches the bundle (upstream fetched once across two requests)", async () => {
    const fetchMock = vi.fn(async () => new Response("export default {};", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await app.inject({ method: "GET", url: "/renderers/cached-one" });
    await app.inject({ method: "GET", url: "/renderers/cached-one" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
