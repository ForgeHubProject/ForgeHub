import { registerHandler } from "./registry.js";
import { gltfSceneHandler } from "./gltf-scene/index.js";

registerHandler(gltfSceneHandler);

export { getHandler, firstHandlerForPath, matchHandlersForPath } from "./registry.js";
export { GLTF_SCENE_HANDLER_ID } from "./types.js";
export { compareGltfSceneSnapshots } from "./gltf-scene/index.js";
export type { GltfCompareResult } from "./gltf-scene/index.js";
export type { ArtifactHandler, IngestInput, HandlerCapabilities } from "./types.js";
