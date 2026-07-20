import { parse as parseToml } from "smol-toml";

// The FHR manifest is the single source of truth for format→handler resolution
// (#74). ForgeHub itself holds NO per-format knowledge: which extensions are
// diffable, which handler covers them, and where that handler's wasm build and
// renderer bundle live are all read from the manifest we fetch here. "Official"
// is a *trust* designation — we trust exactly this one source — never baked-in
// format logic. To point ForgeHub at a self-hosted/forked registry, override
// FHR_MANIFEST_URL; nothing else in the API needs to change.
const FHR_MANIFEST_URL =
  process.env["FHR_MANIFEST_URL"] ??
  "https://raw.githubusercontent.com/ForgeHubProject/FHR/main/manifest.toml";

// Re-fetch at most this often. Between fetches the parsed manifest is served
// from memory so a hot path (every /filediff, /renderers, /fhr/formats call)
// does not hit GitHub.
const CACHE_TTL_MS = 5 * 60 * 1000;

/** The three lookups ForgeHub derives from the manifest — nothing format-specific. */
export type ParsedManifest = {
  /** lowercased file extension (".gltf") → official handler id ("gltf-scene"). */
  formats: Map<string, string>;
  /** handler id → wasm build download URL. */
  wasmUrls: Map<string, string>;
  /** handler id → renderer ESM bundle URL. */
  rendererUrls: Map<string, string>;
};

type CacheEntry = { manifest: ParsedManifest; fetchedAt: number };
let cache: CacheEntry | null = null;
let inflight: Promise<ParsedManifest> | null = null;

/**
 * Project the fhr-official manifest TOML into ForgeHub's three lookups. Shape
 * (see ForgeHubProject/FHR/manifest.toml):
 *   [formats]  ".gltf" = { handler = "gltf-scene", build = "…" }
 *   [assets.handlers."gltf-scene"]  wasm = "https://…/forge-handler-gltf-scene.wasm"
 *   [assets.renderers]  "gltf-scene" = "https://…/renderer-gltf-scene.js"
 * Unknown/extra keys (native binaries, metadata) are ignored — ForgeHub only
 * consumes the wasm build and the renderer bundle.
 */
export function parseManifest(toml: string): ParsedManifest {
  const raw = parseToml(toml) as {
    formats?: Record<string, { handler?: unknown }>;
    assets?: {
      handlers?: Record<string, Record<string, unknown>>;
      renderers?: Record<string, unknown>;
    };
  };

  const formats = new Map<string, string>();
  for (const [ext, entry] of Object.entries(raw.formats ?? {})) {
    const handler = entry?.handler;
    if (typeof handler === "string") formats.set(ext.toLowerCase(), handler);
  }

  const wasmUrls = new Map<string, string>();
  for (const [id, assets] of Object.entries(raw.assets?.handlers ?? {})) {
    const wasm = assets?.["wasm"];
    if (typeof wasm === "string") wasmUrls.set(id, wasm);
  }

  const rendererUrls = new Map<string, string>();
  for (const [id, url] of Object.entries(raw.assets?.renderers ?? {})) {
    if (typeof url === "string") rendererUrls.set(id, url);
  }

  return { formats, wasmUrls, rendererUrls };
}

/**
 * Return the current manifest, fetching+parsing it if the cache is empty or
 * stale. Fetches are coalesced (a single in-flight request serves all callers).
 *
 * Stale-on-error: if a refresh fails but we have a previously-good manifest, we
 * keep serving it — a GitHub hiccup must never take diffs/renderers down. Only
 * a cold start with an unreachable manifest rejects, so callers can surface a
 * 503 rather than a wrong answer.
 */
async function getManifest(): Promise<ParsedManifest> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.manifest;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(FHR_MANIFEST_URL);
      if (!res.ok) throw new Error(`FHR manifest fetch failed: HTTP ${res.status}`);
      const manifest = parseManifest(await res.text());
      cache = { manifest, fetchedAt: Date.now() };
      return manifest;
    } catch (err) {
      if (cache) return cache.manifest; // stale-on-error
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The official format→handler map (lowercased ext → handler id). */
export async function officialFormats(): Promise<Map<string, string>> {
  return (await getManifest()).formats;
}

/** The wasm build URL for a handler id, or null if the manifest has none. */
export async function handlerWasmUrl(handlerId: string): Promise<string | null> {
  return (await getManifest()).wasmUrls.get(handlerId) ?? null;
}

/** The renderer bundle URL for a handler id, or null if the manifest has none. */
export async function rendererUrl(handlerId: string): Promise<string | null> {
  return (await getManifest()).rendererUrls.get(handlerId) ?? null;
}

/** The handler ids the manifest declares a renderer bundle for. */
export async function rendererIds(): Promise<string[]> {
  return [...(await getManifest()).rendererUrls.keys()];
}

/** Test hook: install a manifest directly from TOML, bypassing the fetch. */
export function __setManifestForTests(toml: string): void {
  cache = { manifest: parseManifest(toml), fetchedAt: Date.now() };
  inflight = null;
}

/** Test hook: drop the cached manifest so a stubbed fetch is observed. */
export function __resetManifest(): void {
  cache = null;
  inflight = null;
}
