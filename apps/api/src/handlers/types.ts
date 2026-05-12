export const GLTF_SCENE_HANDLER_ID = "gltf-scene";

export type HandlerId = string;

/** Capabilities for future routing (queues, viewers, etc.). */
export type HandlerCapabilities = {
  semanticCompare: boolean;
};

export type IngestInput = {
  repoId: string;
  sourceFile: string;
  utf8Text: string;
  label: string | null;
  gitCommitSha: string | null;
};

export type ArtifactHandler = {
  id: HandlerId;
  capabilities: HandlerCapabilities;
  matchesPath(path: string): boolean;
  ingestFromUtf8Text(input: IngestInput): Promise<string>;
};
