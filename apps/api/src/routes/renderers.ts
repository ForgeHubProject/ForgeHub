import type { FastifyInstance } from "fastify";

// Same-origin proxy + cache for FHR renderer bundles. The web app can't
// `import()` a bundle straight from GitHub releases — those are served as
// application/octet-stream, which browsers reject for ES modules — so ForgeHub
// fetches it once and re-serves it with a JS MIME type (SPEC-RENDERING.md §3a).
//
// The upstream base is configurable; it defaults to the fhr-official rolling
// release, whose renderer asset is named `renderer-<handlerId>.js`.
const RENDERER_BASE =
  process.env["FHR_RENDERER_BASE"] ??
  "https://github.com/forgehubproject/fhr/releases/download/gltf-scene-latest";

const HANDLER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// A full renderer asset filename, e.g. "renderer-gltf-scene.js" or the lazy 3D
// chunk sibling "renderer-gltf-scene-3d.js" that a lite bundle dynamic-imports.
const RENDERER_ASSET_RE = /^renderer-[a-z0-9][a-z0-9-]*\.js$/;
const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = { js: string | null; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: drop the in-memory cache so a test's stubbed fetch is observed. */
export function __clearRendererCache(): void {
  cache.clear();
}

// Map a request segment to an upstream asset filename. Two shapes are accepted:
// a bare handler id ("gltf-scene" → renderer-gltf-scene.js), and a full renderer
// filename ("renderer-gltf-scene-3d.js") which a lite bundle lazy-imports as a
// sibling — served verbatim. Returns null for anything unsafe, so the value can
// never escape the fixed RENDERER_BASE (no dots or slashes get through).
function assetFilename(raw: string): string | null {
  if (RENDERER_ASSET_RE.test(raw)) return raw;
  const id = raw.replace(/\.js$/, "");
  if (HANDLER_ID_RE.test(id)) return `renderer-${id}.js`;
  return null;
}

async function fetchRendererAsset(filename: string): Promise<string | null> {
  try {
    const res = await fetch(`${RENDERER_BASE}/${filename}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function rendererRoutes(app: FastifyInstance) {
  app.get("/renderers/:asset", async (request, reply) => {
    const raw = (request.params as { asset: string }).asset;
    const filename = assetFilename(raw);
    if (!filename) {
      return reply.status(400).send({ error: "invalid renderer asset" });
    }

    const hit = cache.get(filename);
    let js: string | null;
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      js = hit.js;
    } else {
      js = await fetchRendererAsset(filename);
      cache.set(filename, { js, fetchedAt: Date.now() });
    }

    if (js === null) {
      return reply.status(404).send({ error: `no renderer asset '${filename}'` });
    }
    return reply
      .header("Content-Type", "text/javascript; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(js);
  });
}
