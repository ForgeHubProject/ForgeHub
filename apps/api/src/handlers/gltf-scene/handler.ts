import { prisma } from "../../prisma.js";
import { parseGltf, type GltfDocument, type ParsedEntity } from "../../gltf-parser.js";
import type { ArtifactHandler, IngestInput, StructuredDiff, DiffChange } from "../types.js";
import { GLTF_SCENE_HANDLER_ID } from "../types.js";

const EPS = 1e-4;

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

function approxEq(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < EPS;
}

function diffGltfEntities(baseEntities: ParsedEntity[], headEntities: ParsedEntity[]): DiffChange[] {
  const baseMap = new Map(baseEntities.map((e) => [e.entityId, e]));
  const headMap = new Map(headEntities.map((e) => [e.entityId, e]));
  const allIds = new Set([...baseMap.keys(), ...headMap.keys()]);

  const changes: DiffChange[] = [];

  for (const id of allIds) {
    const b = baseMap.get(id);
    const h = headMap.get(id);

    if (!b && h) {
      changes.push({ path: h.path, kind: "added", label: h.name });
      continue;
    }
    if (b && !h) {
      changes.push({ path: b.path, kind: "removed", label: b.name });
      continue;
    }
    if (!b || !h) continue;

    const fieldChanges: DiffChange[] = [];

    const posChanged =
      !approxEq(b.transform?.position[0], h.transform?.position[0]) ||
      !approxEq(b.transform?.position[1], h.transform?.position[1]) ||
      !approxEq(b.transform?.position[2], h.transform?.position[2]);
    if (posChanged) {
      fieldChanges.push({
        path: "position",
        kind: "modified",
        before: b.transform?.position ?? null,
        after: h.transform?.position ?? null,
      });
    }

    const rotChanged =
      !approxEq(b.transform?.rotationEulerDeg[0], h.transform?.rotationEulerDeg[0]) ||
      !approxEq(b.transform?.rotationEulerDeg[1], h.transform?.rotationEulerDeg[1]) ||
      !approxEq(b.transform?.rotationEulerDeg[2], h.transform?.rotationEulerDeg[2]);
    if (rotChanged) {
      fieldChanges.push({
        path: "rotation",
        kind: "modified",
        before: b.transform?.rotationEulerDeg ?? null,
        after: h.transform?.rotationEulerDeg ?? null,
      });
    }

    const scaleChanged =
      !approxEq(b.transform?.scale[0], h.transform?.scale[0]) ||
      !approxEq(b.transform?.scale[1], h.transform?.scale[1]) ||
      !approxEq(b.transform?.scale[2], h.transform?.scale[2]);
    if (scaleChanged) {
      fieldChanges.push({
        path: "scale",
        kind: "modified",
        before: b.transform?.scale ?? null,
        after: h.transform?.scale ?? null,
      });
    }

    if (b.name !== h.name) {
      fieldChanges.push({ path: "name", kind: "modified", before: b.name, after: h.name });
    }

    if (b.parentEntityId !== h.parentEntityId) {
      fieldChanges.push({ path: "parent", kind: "modified", before: b.parentEntityId, after: h.parentEntityId });
    }

    const bAttr = JSON.stringify(b.attributes);
    const hAttr = JSON.stringify(h.attributes);
    if (bAttr !== hAttr) {
      fieldChanges.push({ path: "attributes", kind: "modified", before: b.attributes, after: h.attributes });
    }

    if (fieldChanges.length > 0) {
      changes.push({ path: h.path, kind: "modified", label: h.name, children: fieldChanges });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

async function diffGltf(base: Buffer, head: Buffer): Promise<StructuredDiff> {
  const parse = (buf: Buffer): ParsedEntity[] => {
    const doc = JSON.parse(buf.toString("utf8")) as GltfDocument;
    return parseGltf(doc);
  };
  return {
    version: "1.0",
    format: "gltf-scene",
    changes: diffGltfEntities(parse(base), parse(head)),
  };
}

export const gltfSceneHandler: ArtifactHandler = {
  id: GLTF_SCENE_HANDLER_ID,
  capabilities: { semanticCompare: true, semanticMerge: false },
  matchesPath: matchesGltfPath,
  ingestFromUtf8Text: ingestGltfUtf8,
  diff: diffGltf,
};
