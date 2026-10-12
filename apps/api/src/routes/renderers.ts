import type { FastifyInstance, FastifyReply } from "fastify";
import { handlerBuild, rendererIds, rendererUrl } from "../fhr/manifest.js";

// Same-origin proxy + cache for FHR renderer bundles. The web app can't
// `import()` a bundle straight from GitHub releases — those are served as
// application/octet-stream, which browsers reject for ES modules — so ForgeHub
// fetches it once and re-serves it with a JS MIME type (SPEC-RENDERING.md §3a).
//
// Where each bundle lives comes from the FHR manifest (the single source of
// truth, #74): ForgeHub embeds no renderer URLs of its own. FHR_RENDERER_BASE
// is an explicit self-hosting override; when set, the manifest is skipped and
// assets are read from `<base>/renderer-<id>.js`.
//
// Each cached bundle is stamped with the build the manifest gave its handler
// when it was fetched, and only answers for that build. FHR republishes a
// rolling release (`ipynb-latest`) at the same URL, so the URL alone can't tell
// an old bundle from a new one; the manifest's build can, and the server's wasm
// handlers follow it the same way (official-handlers.ts). Keyed by filename
// alone, a new handler's diffs were drawn by the old renderer until the hour
// ran out (FHR#109 — observed 2026-10-12).
//
// The web app asks for `/renderers/<build>/<asset>`. The build exists only to
// bust the browser's max-age cache: the server always serves the build its
// manifest names, never one a URL names. A build in the path rather than the
// query because a lite bundle finds its lazy 3D chunk from its own URL with the
// file name (and any query) swapped out — so `/renderers/<build>/<id>` sends
// the chunk to `/renderers/<build>/renderer-<id>-3d.js` with the build intact.
const RENDERER_BASE = process.env["FHR_RENDERER_BASE"];

const HANDLER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// A full renderer asset filename, e.g. "renderer-gltf-scene.js" or the lazy 3D
// chunk sibling "renderer-gltf-scene-3d.js" that a lite bundle dynamic-imports.
const RENDERER_ASSET_RE = /^renderer-[a-z0-9][a-z0-9-]*\.js$/;
const CACHE_TTL_MS = 60 * 60 * 1000;
// A MISS is cached only briefly. Caching it for the full hour turned one
// transient upstream failure into an hour of 404s for a bundle GitHub was
// serving fine the whole time — observed live after an API restart cleared a
// warm cache into a burst of concurrent fetches. Same policy as the wasm side
// (official-handlers.ts): successes are memoized, failures are retried. The
// short window still absorbs a request stampede while upstream is down.
const MISS_TTL_MS = 30 * 1000;

// One entry per filename: a new build replaces the old one, so the map never
// holds more than the current bundles.
type CacheEntry = { build: string | null; js: string | null; fetchedAt: number };
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

// Resolve where a renderer asset lives and the build it belongs to, via the
// manifest. The manifest keys renderers by handler id ("gltf-scene" →
// renderer-gltf-scene.js), and the handler's build is the renderer's build too
// (released together, SPEC-RENDERING §2c). A lite bundle's lazy sibling
// ("renderer-gltf-scene-3d.js") is not itself a manifest key, so we find the
// manifest renderer whose id is the longest prefix of the requested id part and
// fetch that bundle's directory sibling, under that handler's build. The url is
// null when no manifest renderer covers the asset.
async function resolveUpstream(filename: string): Promise<{ url: string | null; build: string | null }> {
  const idPart = idPartOf(filename);

  const exact = await rendererUrl(idPart);
  if (exact) return { url: exact, build: await handlerBuild(idPart) };

  // Not itself a manifest key (e.g. the lazy "gltf-scene-3d" chunk): serve it
  // from the directory of the manifest renderer whose id is the longest prefix.
  let bestId: string | null = null;
  for (const id of await rendererIds()) {
    if (idPart === id || idPart.startsWith(`${id}-`)) {
      if (!bestId || id.length > bestId.length) bestId = id;
    }
  }
  if (!bestId) return { url: null, build: null };

  const baseUrl = await rendererUrl(bestId);
  if (!baseUrl) return { url: null, build: null };
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf("/"));
  return { url: `${dir}/${filename}`, build: await handlerBuild(bestId) };
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
  const serve = async (raw: string, requestedBuild: string | undefined, reply: FastifyReply) => {
    const filename = assetFilename(raw);
    if (!filename) {
      return reply.status(400).send({ error: "invalid renderer asset" });
    }

    let upstream: { url: string | null; build: string | null };
    if (RENDERER_BASE) {
      // Self-hosting override: fixed release-layout URL, manifest skipped — so
      // there is no build to follow and the TTL alone ages the bundle out.
      upstream = { url: `${RENDERER_BASE}/${filename}`, build: null };
    } else {
      try {
        upstream = await resolveUpstream(filename);
      } catch {
        upstream = { url: null, build: null }; // manifest unreachable with no cache — treat as missing
      }
    }

    const hit = cache.get(filename);
    let js: string | null;
    if (
      hit &&
      hit.build === upstream.build &&
      Date.now() - hit.fetchedAt < (hit.js === null ? MISS_TTL_MS : CACHE_TTL_MS)
    ) {
      js = hit.js;
    } else {
      js = upstream.url ? await fetchRendererAsset(upstream.url) : null;
      cache.set(filename, { build: upstream.build, js, fetchedAt: Date.now() });
    }

    if (js === null) {
      return reply.status(404).send({ error: `no renderer asset '${filename}'` });
    }
    // A URL naming a build other than the one served (a tab that read the
    // build before the manifest moved) gets the current bundle, but the browser
    // must not keep it under that build's URL for an hour.
    const mislabeled =
      requestedBuild !== undefined && upstream.build !== null && requestedBuild !== upstream.build;
    return reply
      .header("Content-Type", "text/javascript; charset=utf-8")
      .header("Cache-Control", mislabeled ? "no-store" : "public, max-age=3600")
      .send(js);
  };

  app.get("/renderers/:asset", async (request, reply) => {
    const { asset } = request.params as { asset: string };
    return serve(asset, undefined, reply);
  });

  // The build is only compared with the manifest's, never used as a key or in
  // a URL (the router already bounds a parameter's length).
  app.get("/renderers/:build/:asset", async (request, reply) => {
    const { build, asset } = request.params as { build: string; asset: string };
    return serve(asset, build, reply);
  });
}
