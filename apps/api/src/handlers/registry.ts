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
 * Resolve a handler scoped to one repo's opt-in extension set (its
 * .forge/formats file). The global registry is the pool of available
 * handlers; this narrows the selection to what the repo enabled. An empty
 * set means the repo has not opted in to any semantic handling, so no
 * handler is returned.
 */
export function firstHandlerForPathAndFormats(
  filePath: string,
  activeExts: Set<string>,
): ArtifactHandler | undefined {
  if (!activeExts.has(extname(filePath).toLowerCase())) return undefined;
  return firstHandlerForPath(filePath);
}
