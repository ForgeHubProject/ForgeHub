import type { FastifyInstance } from "fastify";
import { rendererIds, rendererUrl } from "../fhr/manifest.js";

// Same-origin proxy + cache for FHR renderer bundles. The web app can't
// `import()` a bundle straight from GitHub releases — those are served as
// application/octet-stream, which browsers reject for ES modules — so ForgeHub
// fetches it once and re-serves it with a JS MIME type (SPEC-RENDERING.md §3a).
//
// Where each bundle lives comes from the FHR manifest (the single source of
// truth, #74): ForgeHub embeds no renderer URLs of its own. FHR_RENDERER_BASE
// is an explicit self-hosting override; when set, the manifest is skipped and
// assets are read from `<base>/renderer-<id>.js`.
const RENDERER_BASE = process.env["FHR_RENDERER_BASE"];

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
// never escape the resolved base URL (no dots or slashes get through).
function assetFilename(raw: string): string | null {
  if (RENDERER_ASSET_RE.test(raw)) return raw;
  const id = raw.replace(/\.js$/, "");
  if (HANDLER_ID_RE.test(id)) return `renderer-${id}.js`;
  return null;
}

// The "<id>" part of a "renderer-<id>.js" filename (already validated safe).
function idPartOf(filename: string): string {
  return filename.slice("renderer-".length, -".js".length);
}

// Resolve the upstream URL for a renderer asset via the manifest. The manifest
// keys renderers by handler id ("gltf-scene" → renderer-gltf-scene.js). A lite
// bundle's lazy sibling ("renderer-gltf-scene-3d.js") is not itself a manifest
// key, so we find the manifest renderer whose id is the longest prefix of the
// requested id part and fetch that bundle's directory sibling. Returns null when
// no manifest renderer covers the asset.
async function resolveUpstreamUrl(filename: string): Promise<string | null> {
  const idPart = idPartOf(filename);

  const exact = await rendererUrl(idPart);
  if (exact) return exact;

  // Not itself a manifest key (e.g. the lazy "gltf-scene-3d" chunk): serve it
  // from the directory of the manifest renderer whose id is the longest prefix.
  let bestId: string | null = null;
  for (const id of await rendererIds()) {
    if (idPart === id || idPart.startsWith(`${id}-`)) {
      if (!bestId || id.length > bestId.length) bestId = id;
    }
  }
  if (!bestId) return null;

  const baseUrl = await rendererUrl(bestId);
  if (!baseUrl) return null;
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf("/"));
  return `${dir}/${filename}`;
}

async function fetchRendererAsset(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
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
      let url: string | null;
      if (RENDERER_BASE) {
        // Self-hosting override: fixed release-layout URL, manifest skipped.
        url = `${RENDERER_BASE}/${filename}`;
      } else {
        try {
          url = await resolveUpstreamUrl(filename);
        } catch {
          url = null; // manifest unreachable with no cache — treat as missing
        }
      }
      js = url ? await fetchRendererAsset(url) : null;
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
