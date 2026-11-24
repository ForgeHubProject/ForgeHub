import { extname } from "node:path";
import type { ArtifactHandler } from "./types.js";

const byId = new Map<string, ArtifactHandler>();

export function registerHandler(handler: ArtifactHandler): void {
  byId.set(handler.id, handler);
}

export function getHandler(id: string): ArtifactHandler | undefined {
  return byId.get(id);
}

/** Handlers that claim this path (stable registration order). */
export function matchHandlersForPath(path: string): ArtifactHandler[] {
  return [...byId.values()].filter((h) => h.matchesPath(path));
}

export function firstHandlerForPath(path: string): ArtifactHandler | undefined {
  return matchHandlersForPath(path)[0];
}

/**
 * Resolve a handler scoped to the extensions in effect for one repo (its
 * .forge/formats file, read by formatsInEffect). The global registry is the
 * pool of available handlers; this narrows the selection to what the repo has
 * on. An empty set means nothing is on, so no handler is returned.
 */
export function firstHandlerForPathAndFormats(
  filePath: string,
  activeExts: Set<string>,
): ArtifactHandler | undefined {
  if (!activeExts.has(extname(filePath).toLowerCase())) return undefined;
  return firstHandlerForPath(filePath);
}
