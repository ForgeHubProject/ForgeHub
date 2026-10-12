import { API_BASE, getFhrBuilds } from "../api";

// The mount() contract a built FHR renderer bundle exposes (SPEC-RENDERING §2b).
// Kept as a local structural type so the web app needs no build-time dependency
// on the FHR packages — the bundle is loaded at runtime from the API proxy.
export type RendererMountProps = {
  mode: "view" | "diff" | "merge";
  diff?: unknown;
  blobs?: unknown;
  /** The handler's previews of the same sides (FHR SPEC §7), when it has them. */
  previews?: unknown;
  theme?: "light" | "dark";
  onEvent?: (e: unknown) => void;
};

export type RendererInstance = {
  update(props: RendererMountProps): void;
  unmount(): void;
};

export type RendererBundle = {
  fhrVersion: number;
  handlerId: string;
  extensions: string[];
  /** The modes the bundle draws (SPEC-RENDERING §2b); absent means all three. */
  modes?: readonly RendererMountProps["mode"][];
  mount(el: HTMLElement, props: RendererMountProps): RendererInstance;
};

/**
 * Does the bundle draw `mode` itself? A renderer built for diffs only lists
 * `["diff"]`, and a single file of its format is then the host's to show.
 */
export function drawsMode(bundle: Pick<RendererBundle, "modes">, mode: RendererMountProps["mode"]): boolean {
  return bundle.modes === undefined || bundle.modes.includes(mode);
}

// Each handler's current build, re-read every few minutes — the API refreshes
// its manifest on the same cadence — so a tab left open across an FHR release
// loads the new renderer instead of keeping the one it saw first.
const BUILDS_TTL_MS = 5 * 60 * 1000;
let builds: { fetchedAt: number; p: Promise<ReadonlyMap<string, string>> } | null = null;

/** The handler's current build, or null when unstamped or the lookup failed. */
async function currentBuild(handlerId: string): Promise<string | null> {
  if (!builds || Date.now() - builds.fetchedAt >= BUILDS_TTL_MS) {
    const entry = {
      fetchedAt: Date.now(),
      p: getFhrBuilds().then((b): ReadonlyMap<string, string> => new Map(Object.entries(b))),
    };
    builds = entry;
    // Don't keep a failed lookup — the next load asks again.
    entry.p.catch(() => {
      if (builds === entry) builds = null;
    });
  }
  try {
    return (await builds.p).get(handlerId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where a renderer bundle is served. The build sits in the PATH, not the query:
 * it busts the browser's hour-long cache of the old build, and a lite bundle
 * finds its lazy 3D chunk by swapping the file name (and any query) in its own
 * URL — so the chunk lands on /renderers/<build>/renderer-<id>-3d.js and is
 * busted too. With no build known, the unversioned URL still serves.
 */
export function rendererBundleUrl(handlerId: string, build: string | null): string {
  const id = encodeURIComponent(handlerId);
  return build ? `${API_BASE}/renderers/${encodeURIComponent(build)}/${id}` : `${API_BASE}/renderers/${id}`;
}

type ImportModule = (url: string) => Promise<{ default?: unknown }>;
const importBundle: ImportModule = (url) => import(/* @vite-ignore */ url);

// One in-flight/resolved import per handler, for the build it was loaded at —
// the bundle is a singleton module. A new build imports the new bundle.
const cache = new Map<string, { build: string | null; p: Promise<RendererBundle> }>();

/** Test hook: forget loaded bundles and the build lookup. */
export function __resetRendererBundles(): void {
  cache.clear();
  builds = null;
}

/**
 * Dynamically import a handler's renderer bundle at its current build, served
 * same-origin-ish by the API's /renderers proxy (which re-serves it with a JS
 * MIME type so import() accepts it). Cached so repeated diffs reuse the one
 * module until the manifest names a new build.
 */
export async function loadRendererBundle(
  handlerId: string,
  importModule: ImportModule = importBundle,
): Promise<RendererBundle> {
  const build = await currentBuild(handlerId);
  const hit = cache.get(handlerId);
  // An unknown build (lookup failed) keeps whatever is already loaded.
  if (hit && (hit.build === build || build === null)) return hit.p;

  const p = importModule(rendererBundleUrl(handlerId, build)).then(
    (m) => (m.default ?? m) as RendererBundle,
  );
  const entry = { build, p };
  cache.set(handlerId, entry);
  // Don't cache a rejected import — allow a later retry.
  p.catch(() => {
    if (cache.get(handlerId) === entry) cache.delete(handlerId);
  });
  return p;
}
