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
let cached: Promise<ReadonlySet<string>> | null = null;

/**
 * Fetch (once, cached) the set of semantic file extensions the FHR manifest
 * advertises — lowercase, no leading dot. Never rejects for callers that don't
 * want to handle failure: on error it clears the cache and re-throws, so the
 * hook below can decide to stay empty.
 */
export function loadSemanticExtensions(): Promise<ReadonlySet<string>> {
  if (!cached) {
    const p: Promise<ReadonlySet<string>> = getFhrFormats().then(
      (formats) => new Set(Object.keys(formats).map(normalizeExtension)),
    );
    // Don't cache a rejected fetch — allow a later retry.
    p.catch(() => {
      if (cached === p) cached = null;
    });
    cached = p;
  }
  return cached;
}

/** Testing helper: drop the cached manifest promise so the next call refetches. */
export function resetSemanticExtensionsCache(): void {
  cached = null;
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
