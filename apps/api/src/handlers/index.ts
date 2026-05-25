import { registerHandler } from "./registry.js";
import { gltfSceneHandler } from "./gltf-scene/index.js";
import { plainTextHandler } from "./plain-text/index.js";

registerHandler(gltfSceneHandler);
registerHandler(plainTextHandler);

export { getHandler, firstHandlerForPath, matchHandlersForPath } from "./registry.js";
export {
  GLTF_SCENE_HANDLER_ID,
  PLAIN_TEXT_HANDLER_ID,
} from "./types.js";
export { compareGltfSceneSnapshots } from "./gltf-scene/index.js";
export type { GltfCompareResult } from "./gltf-scene/index.js";
export { comparePlainTextSnapshots, PLAIN_TEXT_MAX_BYTES } from "./plain-text/index.js";
export type { PlainTextCompareResult, TextDiffLine } from "./plain-text/index.js";
export type {
  ArtifactHandler,
  IngestInput,
  HandlerCapabilities,
  StructuredDiff,
  DiffChange,
  ChangeKind,
  ConflictInfo,
  SemanticConflict,
  MergeResult,
} from "./types.js";
