import type { FastifyInstance } from "fastify";
import { handlerWasmUrl } from "../fhr/manifest.js";

// Same-origin proxy + cache for official FHR handler *wasm builds*, the Tier-B
// (in-browser compute) sibling of the /renderers bundle proxy. The web app
// can't reliably fetch the wasm straight from GitHub releases: the manifest may
// point anywhere (self-hosted registries) without CORS headers, and the browser
// must be able to trust that what it executes is an *official* build. So
// ForgeHub fetches the build once and re-serves it same-origin, typed
// application/wasm (SPEC-RENDERING §4, Tier B).
//
// Trust model is identical to /renderers and the server's own wasm runner:
// ONLY handlers the official manifest declares a wasm build for are served —
// this proxy never fetches a community source. Where each build lives comes
// from the manifest; FHR_WASM_BASE is the same explicit self-hosting override
// official-handlers.ts honors, deriving the URL from the fixed
// `forge-handler-<id>.wasm` release convention.
const WASM_BASE = process.env["FHR_WASM_BASE"];

// Length-bounded: the id is unauthenticated attacker input and becomes a cache
// key, so it can't be an arbitrarily long string.
const HANDLER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A full wasm asset filename, e.g. "forge-handler-gltf-scene.wasm".
const WASM_ASSET_RE = /^forge-handler-[a-z0-9][a-z0-9-]{0,63}\.wasm$/;
const CACHE_TTL_MS = 60 * 60 * 1000;
// Entries hold whole wasm binaries and are keyed by unauthenticated input, so
// the map is bounded and evicts oldest-first. The official manifest declares a
// handful of handlers; anything beyond that is noise, not working set.
const CACHE_MAX_ENTRIES = 16;

type CacheEntry = { bytes: Buffer | null; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

// Map iteration is insertion-ordered, so the first key is the oldest write.
function cacheStore(handlerId: string, entry: CacheEntry): void {
  cache.delete(handlerId);
  cache.set(handlerId, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test-only: drop the in-memory cache so a test's stubbed fetch is observed. */
export function __clearHandlerWasmCache(): void {
  cache.clear();
}

// Map a request segment to a handler id. Two shapes are accepted: a bare
// handler id ("gltf-scene") and the full release filename
// ("forge-handler-gltf-scene.wasm"). Returns null for anything unsafe, so the
// value can never escape the resolved base URL (no dots or slashes get
// through).
function handlerIdOf(raw: string): string | null {
  if (WASM_ASSET_RE.test(raw)) {
    return raw.slice("forge-handler-".length, -".wasm".length);
  }
  if (HANDLER_ID_RE.test(raw)) return raw;
  return null;
}

async function fetchWasmAsset(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function handlerWasmRoutes(app: FastifyInstance) {
  app.get("/handlers/:asset", async (request, reply) => {
    const raw = (request.params as { asset: string }).asset;
    const handlerId = handlerIdOf(raw);
    if (!handlerId) {
      return reply.status(400).send({ error: "invalid handler asset" });
    }

    const hit = cache.get(handlerId);
    let bytes: Buffer | null;
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      bytes = hit.bytes;
    } else {
      let url: string | null;
      if (WASM_BASE) {
        // Self-hosting override: fixed release-layout URL, manifest skipped.
        url = `${WASM_BASE}/forge-handler-${handlerId}.wasm`;
      } else {
        try {
          url = await handlerWasmUrl(handlerId);
        } catch {
          url = null; // manifest unreachable with no cache — treat as missing
        }
      }
      bytes = url ? await fetchWasmAsset(url) : null;
      cacheStore(handlerId, { bytes, fetchedAt: Date.now() });
    }

    if (bytes === null) {
      return reply.status(404).send({ error: `no wasm build for handler '${handlerId}'` });
    }
    return reply
      .header("Content-Type", "application/wasm")
      .header("Cache-Control", "public, max-age=3600")
      .send(bytes);
  });
}
