import { prisma } from "../prisma.js";
import { parseGltf, type GltfDocument } from "../gltf-parser.js";
import type { ArtifactHandler, IngestInput } from "./types.js";
import { GLTF_SCENE_HANDLER_ID } from "./types.js";

function matchesGltfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".gltf");
}

async function ingestGltfUtf8(input: IngestInput): Promise<string> {
  const { repoId, sourceFile, utf8Text, label, gitCommitSha } = input;

  if (gitCommitSha) {
    const existing = await prisma.snapshot.findFirst({
      where: { repoId, gitCommitSha, sourceFile },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  let gltf: GltfDocument;
  try {
    gltf = JSON.parse(utf8Text) as GltfDocument;
  } catch {
    throw new Error("Invalid JSON (expected glTF)");
  }

  const entities = parseGltf(gltf);

  const snapshot = await prisma.snapshot.create({
    data: {
      repoId,
      handlerId: GLTF_SCENE_HANDLER_ID,
      label,
      sourceFile,
      gitCommitSha,
      entities: {
        create: entities.map((e) => ({
          entityId: e.entityId,
          parentEntityId: e.parentEntityId ?? null,
          kind: e.kind,
          name: e.name,
          path: e.path,
          posX: e.transform?.position[0] ?? null,
          posY: e.transform?.position[1] ?? null,
          posZ: e.transform?.position[2] ?? null,
          rotX: e.transform?.rotationEulerDeg[0] ?? null,
          rotY: e.transform?.rotationEulerDeg[1] ?? null,
          rotZ: e.transform?.rotationEulerDeg[2] ?? null,
          scaleX: e.transform?.scale[0] ?? null,
          scaleY: e.transform?.scale[1] ?? null,
          scaleZ: e.transform?.scale[2] ?? null,
          attributes: JSON.stringify(e.attributes),
          renderRef: e.renderRef ? JSON.stringify(e.renderRef) : null,
        })),
      },
    },
    select: { id: true },
  });

  return snapshot.id;
}

export const gltfSceneHandler: ArtifactHandler = {
  id: GLTF_SCENE_HANDLER_ID,
  capabilities: { semanticCompare: true },
  matchesPath: matchesGltfPath,
  ingestFromUtf8Text: ingestGltfUtf8,
};
