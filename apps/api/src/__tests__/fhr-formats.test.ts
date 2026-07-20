/**
 * Public /fhr/formats endpoint. Projects the FHR manifest's [formats] table as
 * { "formats": Record<ext, handlerId> } — the contract the web app codes
 * against. The manifest is stubbed (test hook) for the happy path; the 503 path
 * stubs an unreachable upstream so no network is used.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers/server.js";
import { __setManifestForTests, __resetManifest } from "../fhr/manifest.js";

const MANIFEST = `
[formats]
".gltf" = { handler = "gltf-scene", build = "e520cc6" }
".glb"  = { handler = "gltf-scene", build = "e520cc6" }

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
  globalThis.fetch = realFetch;
});

describe("GET /fhr/formats", () => {
  it("returns the manifest format→handler map (no auth required)", async () => {
    __setManifestForTests(MANIFEST);
    const res = await app.inject({ method: "GET", url: "/fhr/formats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      formats: { ".gltf": "gltf-scene", ".glb": "gltf-scene" },
    });
  });

  it("503s when no manifest has ever been fetched", async () => {
    __resetManifest();
    // Upstream unreachable, cold cache → the endpoint must 503, not 200-with-empty.
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const res = await app.inject({ method: "GET", url: "/fhr/formats" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBeTruthy();
  });
});
