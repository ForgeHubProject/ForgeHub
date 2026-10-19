import { extname } from "node:path";
import { prisma } from "./prisma.js";
import { officialWasmDiff } from "./fhr/official-handlers.js";
import type { DiffChange } from "./handlers/types.js";

/**
 * The scene structure a file holds — its nodes, meshes and materials — read by
 * the file's official FHR handler (#74). ForgeHub keeps no parser of its own:
 * diffing the file against an empty one makes the handler list everything in
 * it as added, under the scene diff's own paths (`nodes/<name>`, …). Every 3D
 * format FHR reads (glTF, OBJ, STL, 3MF, …) converts to that scene first, so
 * entity search covers all of them, not only glTF.
 */

/** The scene diff's collections, and what one member of each is called. */
const COLLECTIONS: Record<string, string> = { nodes: "node", meshes: "mesh", materials: "material" };

/** A bound on one file's entities, so a pathological scene can't flood the table. */
export const MAX_ENTITIES_PER_FILE = 5000;

export type SceneEntity = {
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
};

function lastSegment(path: string): string {
  const seg = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** The entities an added-file diff lists, in the order the handler gave them. */
export function entitiesFromDiff(changes: DiffChange[]): SceneEntity[] {
  const out: SceneEntity[] = [];
  for (const group of changes) {
    const kind = COLLECTIONS[group.path];
    if (!kind) continue;
    for (const member of group.children ?? []) {
      if (out.length >= MAX_ENTITIES_PER_FILE) return out;
      // A node says where it hangs: its `parent` row carries the parent's name.
      const parentRow = kind === "node" ? member.children?.find((c) => c.label === "parent") : undefined;
      const parent = typeof parentRow?.after === "string" && parentRow.after !== "" ? parentRow.after : null;
      out.push({
        entityId: member.path,
        parentEntityId: parent ? `nodes/${encodeURIComponent(parent)}` : null,
        kind,
        name: member.label || lastSegment(member.path),
        path: member.path,
      });
    }
  }
  return out;
}

/**
 * Read a file's scene entities with its official handler. Null when no official
 * handler takes the file, it is over the handler size limit, or the handler
 * could not read it.
 */
export async function sceneEntities(
  filePath: string,
  activeExts: Set<string>,
  bytes: Buffer,
): Promise<{ handlerId: string; entities: SceneEntity[] } | null> {
  const result = await officialWasmDiff(filePath, activeExts, Buffer.alloc(0), bytes);
  if (!result) return null;
  return { handlerId: result.handlerId, entities: entitiesFromDiff(result.diff.changes) };
}

/**
 * Record a snapshot of a file's scene entities, for entity search. Returns its
 * id, or null when no official handler read the file — or, unless
 * `keepEmpty`, when the file holds no scene entities to search.
 */
export async function ingestSceneSnapshot(input: {
  repoId: string;
  sourceFile: string;
  bytes: Buffer;
  label: string | null;
  gitCommitSha: string | null;
  activeExts?: Set<string>;
  keepEmpty?: boolean;
}): Promise<string | null> {
  const { repoId, sourceFile, bytes, label, gitCommitSha } = input;
  if (gitCommitSha) {
    const existing = await prisma.snapshot.findFirst({
      where: { repoId, gitCommitSha, sourceFile },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const activeExts = input.activeExts ?? new Set([extname(sourceFile).toLowerCase()]);
  const read = await sceneEntities(sourceFile, activeExts, bytes);
  if (!read) return null;
  if (read.entities.length === 0 && !input.keepEmpty) return null;

  const snapshot = await prisma.snapshot.create({
    data: {
      repoId,
      handlerId: read.handlerId,
      label,
      sourceFile,
      gitCommitSha,
      entities: {
        create: read.entities.map((e) => ({
          entityId: e.entityId,
          parentEntityId: e.parentEntityId,
          kind: e.kind,
          name: e.name,
          path: e.path,
        })),
      },
    },
    select: { id: true },
  });
  return snapshot.id;
}
