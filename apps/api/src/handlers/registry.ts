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
