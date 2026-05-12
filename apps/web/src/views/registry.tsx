import type { ComponentType } from "react";
import { GLTF_SCENE_HANDLER_ID } from "./constants";
import { FallbackWorkspaceView } from "./FallbackWorkspaceView";
import { GltfSceneView } from "./GltfSceneView";
import type { RepoCodeWorkspaceProps } from "./repoWorkspaceTypes";

const registry = new Map<string, ComponentType<RepoCodeWorkspaceProps>>([
  [GLTF_SCENE_HANDLER_ID, GltfSceneView],
]);

/** Register a workspace component for a snapshot handlerId (e.g. from a lazy-loaded plugin). */
export function registerRepoWorkspaceView(
  handlerId: string,
  component: ComponentType<RepoCodeWorkspaceProps>,
): void {
  registry.set(handlerId, component);
}

export function resolveRepoCodeWorkspace(
  handlerId: string | undefined,
): ComponentType<RepoCodeWorkspaceProps> {
  if (handlerId === undefined || handlerId === GLTF_SCENE_HANDLER_ID) {
    return GltfSceneView;
  }
  return registry.get(handlerId) ?? FallbackWorkspaceView;
}
