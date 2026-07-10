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
const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = { js: string | null; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: drop the in-memory cache so a test's stubbed fetch is observed. */
export function __clearRendererCache(): void {
  cache.clear();
}

async function fetchRendererBundle(handlerId: string): Promise<string | null> {
  const url = `${RENDERER_BASE}/renderer-${handlerId}.js`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function rendererRoutes(app: FastifyInstance) {
  app.get("/renderers/:handlerId", async (request, reply) => {
    const raw = (request.params as { handlerId: string }).handlerId;
    const id = raw.replace(/\.js$/, "");
    if (!HANDLER_ID_RE.test(id)) {
      return reply.status(400).send({ error: "invalid handler id" });
    }

    const hit = cache.get(id);
    let js: string | null;
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      js = hit.js;
    } else {
      js = await fetchRendererBundle(id);
      cache.set(id, { js, fetchedAt: Date.now() });
    }

    if (js === null) {
      return reply.status(404).send({ error: `no renderer bundle for handler '${id}'` });
    }
    return reply
      .header("Content-Type", "text/javascript; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(js);
  });
}
