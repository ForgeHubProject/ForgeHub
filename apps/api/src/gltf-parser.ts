type GltfNode = {
  name?: string;
  children?: number[];
  mesh?: number;
  translation?: [number, number, number];
  rotation?: [number, number, number, number]; // quaternion [x, y, z, w]
  scale?: [number, number, number];
};

type GltfScene = {
  nodes?: number[];
  name?: string;
};

export type GltfDocument = {
  asset: { version: string };
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  [key: string]: unknown;
};

export type ParsedEntity = {
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  transform: {
    position: [number, number, number];
    rotationEulerDeg: [number, number, number];
    scale: [number, number, number];
  } | null;
  attributes: Record<string, unknown>;
  renderRef: { type: string; meshIndex: number } | null;
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
}

function quatToEulerDeg(q: [number, number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const toDeg = (r: number) => r * (180 / Math.PI);
  return [toDeg(roll), toDeg(pitch), toDeg(yaw)];
}

export function parseGltf(doc: GltfDocument): ParsedEntity[] {
  const nodes = doc.nodes ?? [];
  const scenes = doc.scenes ?? [];
  const defaultScene = scenes[doc.scene ?? 0];

  if (!defaultScene) throw new Error("glTF has no scenes");

  const rootIndices = defaultScene.nodes ?? [];
  if (rootIndices.length === 0) throw new Error("glTF scene has no root nodes");

  const entities: ParsedEntity[] = [];
  const seenPaths = new Set<string>();

  function uniquePath(base: string): string {
    if (!seenPaths.has(base)) {
      seenPaths.add(base);
      return base;
    }
    let i = 1;
    while (seenPaths.has(`${base}-${i}`)) i++;
    const p = `${base}-${i}`;
    seenPaths.add(p);
    return p;
  }

  // Synthetic root when scene has multiple top-level nodes
  let syntheticRootId: string | null = null;
  if (rootIndices.length > 1) {
    const sceneName = defaultScene.name ?? "scene";
    const rootPath = uniquePath(slugify(sceneName));
    syntheticRootId = rootPath;
    entities.push({
      entityId: rootPath,
      parentEntityId: null,
      kind: "assembly",
      name: sceneName,
      path: rootPath,
      transform: null,
      attributes: {},
      renderRef: null,
    });
  }

  function walk(nodeIndex: number, parentEntityId: string | null, parentPath: string) {
    const node = nodes[nodeIndex];
    if (!node) return;

    const rawName = node.name ?? `node-${nodeIndex}`;
    const slug = slugify(rawName);
    const basePath = parentPath ? `${parentPath}.${slug}` : slug;
    const entityPath = uniquePath(basePath);

    let transform: ParsedEntity["transform"] = null;
    if (node.translation ?? node.rotation ?? node.scale) {
      transform = {
        position: node.translation ?? [0, 0, 0],
        rotationEulerDeg: quatToEulerDeg(node.rotation ?? [0, 0, 0, 1]),
        scale: node.scale ?? [1, 1, 1],
      };
    }

    const hasChildren = (node.children?.length ?? 0) > 0;
    const hasMesh = node.mesh !== undefined;
    const kind = hasChildren ? "assembly" : hasMesh ? "part" : "module";

    entities.push({
      entityId: entityPath,
      parentEntityId,
      kind,
      name: rawName,
      path: entityPath,
      transform,
      attributes: {},
      renderRef: hasMesh ? { type: "mesh", meshIndex: node.mesh! } : null,
    });

    for (const childIndex of node.children ?? []) {
      walk(childIndex, entityPath, entityPath);
    }
  }

  for (const rootIndex of rootIndices) {
    walk(rootIndex, syntheticRootId, "");
  }

  return entities;
}
