import { useEffect, useState } from "react";
import { getFhrFormats } from "../api";

/**
 * Normalize a manifest extension key (".GLTF") — or an extension pulled from a
 * filename — to the registry's key form: lowercase, no leading dot.
 */
export function normalizeExtension(ext: string): string {
  return ext.replace(/^\.+/, "").toLowerCase();
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// One shared manifest fetch for the whole app. A rejection (e.g. the API 503s
// before it has ever fetched a manifest) is NOT cached, so a later mount retries
// and semantic viewers can light up once the manifest becomes available.
let cached: Promise<ReadonlyMap<string, string>> | null = null;

/**
 * Fetch (once, cached) the manifest's format table as a map of extension
 * (lowercase, no leading dot) → handlerId. The single fetch behind both the
 * extension set (viewer routing) and the handler lookup (bundle loading).
 */
export function loadSemanticFormats(): Promise<ReadonlyMap<string, string>> {
  if (!cached) {
    const p: Promise<ReadonlyMap<string, string>> = getFhrFormats().then(
      (formats) =>
        new Map(Object.entries(formats).map(([ext, handlerId]) => [normalizeExtension(ext), handlerId])),
    );
    // Don't cache a rejected fetch — allow a later retry.
    p.catch(() => {
      if (cached === p) cached = null;
    });
    cached = p;
  }
  return cached;
}

/**
 * Fetch (once, cached) the set of semantic file extensions the FHR manifest
 * advertises — lowercase, no leading dot. Never rejects for callers that don't
 * want to handle failure: on error it clears the cache and re-throws, so the
 * hook below can decide to stay empty.
 */
export function loadSemanticExtensions(): Promise<ReadonlySet<string>> {
  return loadSemanticFormats().then((formats) => new Set(formats.keys()));
}

/** Testing helper: drop the cached manifest promise so the next call refetches. */
export function resetSemanticExtensionsCache(): void {
  cached = null;
}

/**
 * Like loadSemanticExtensions, but never rejects: a manifest failure settles
 * to the empty set. For callers that must know the manifest has been CONSULTED
 * — not merely that no formats are known yet — because acting on the empty
 * starting set is itself a bug (BlobViewer would fetch a .glb as text in the
 * gap before the manifest answers).
 */
export function loadSemanticExtensionsSettled(): Promise<ReadonlySet<string>> {
  return loadSemanticExtensions().catch(() => EMPTY_SET);
}

/**
 * Hook variant of the above: `settled` is false only while the manifest fetch
 * is in flight. On failure it settles with the empty set, so a broken manifest
 * degrades to base viewers rather than blocking anything forever.
 */
export function useSemanticFormatsReady(): { extensions: ReadonlySet<string>; settled: boolean } {
  const [state, setState] = useState<{ extensions: ReadonlySet<string>; settled: boolean }>({
    extensions: EMPTY_SET,
    settled: false,
  });
  useEffect(() => {
    let cancelled = false;
    void loadSemanticExtensionsSettled().then((extensions) => {
      if (!cancelled) setState({ extensions, settled: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * React hook exposing the semantic extension set (lowercase, no dot). It starts
 * empty, so every file renders with its base (text/binary) viewer immediately
 * and the UI never blocks on the manifest. When the manifest resolves, a state
 * update re-renders and semantic-capable files upgrade to the FhrFileDiffViewer.
 * A failed fetch simply leaves the set empty — the app degrades, never crashes.
 */
export function useSemanticExtensions(): ReadonlySet<string> {
  const [extensions, setExtensions] = useState<ReadonlySet<string>>(EMPTY_SET);
  useEffect(() => {
    let cancelled = false;
    loadSemanticExtensions()
      .then((set) => {
        if (!cancelled) setExtensions(set);
      })
      .catch(() => {
        // Leave the set empty; files keep their base viewers.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return extensions;
}
