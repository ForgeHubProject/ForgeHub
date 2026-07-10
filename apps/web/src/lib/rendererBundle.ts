import { API_BASE } from "../api";

// The mount() contract a built FHR renderer bundle exposes (SPEC-RENDERING §2b).
// Kept as a local structural type so the web app needs no build-time dependency
// on the FHR packages — the bundle is loaded at runtime from the API proxy.
export type RendererMountProps = {
  mode: "view" | "diff" | "merge";
  diff?: unknown;
  blobs?: unknown;
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
  mount(el: HTMLElement, props: RendererMountProps): RendererInstance;
};

// One in-flight/resolved import per handler — the bundle is a singleton module.
const cache = new Map<string, Promise<RendererBundle>>();

/**
 * Dynamically import a handler's renderer bundle, served same-origin-ish by the
 * API's /renderers proxy (which re-serves it with a JS MIME type so import()
 * accepts it). Cached so repeated diffs reuse the one module.
 */
export function loadRendererBundle(handlerId: string): Promise<RendererBundle> {
  let p = cache.get(handlerId);
  if (!p) {
    const url = `${API_BASE}/renderers/${encodeURIComponent(handlerId)}`;
    p = import(/* @vite-ignore */ url).then((m) => (m.default ?? m) as RendererBundle);
    // Don't cache a rejected import — allow a later retry.
    p.catch(() => cache.delete(handlerId));
    cache.set(handlerId, p);
  }
  return p;
}
