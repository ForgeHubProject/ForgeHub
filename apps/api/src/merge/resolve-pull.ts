import type { Entity } from "@prisma/client";
import { prisma } from "../prisma.js";
import { gltfSceneHandler } from "../handlers/gltf-scene/handler.js";
import { comparePlainTextSnapshots } from "../handlers/plain-text/compare.js";
import { GLTF_SCENE_HANDLER_ID, PLAIN_TEXT_HANDLER_ID } from "../handlers/types.js";
import {
  branchShas,
  listFilesDifferingBetweenBranches,
  performMerge,
  performMergeWithResolvedFiles,
  readFileAtBranch,
  type MergeResult,
} from "../git-utils.js";
import {
  materializeGltfMerge,
  type GltfEntityResolution,
  type GltfFieldResolution,
  type MergeSide,
} from "./gltf-resolve.js";
import { groupPlainTextHunks, materializePlainTextMerge, type TextHunkSide } from "./text-hunks.js";

export type TextFileResolution = {
  sourceFile: string;
  hunks: Array<{ hunkId: string; side: TextHunkSide }>;
};

export type GltfFileResolution = {
  sourceFile: string;
  entities?: GltfEntityResolution[];
  fields?: GltfFieldResolution[];
};

export type MergeFileResolution = TextFileResolution | GltfFileResolution;

type SnapshotWithEntities = {
  id: string;
  handlerId: string;
  snapshotBody: string | null;
  entities: Entity[];
};

async function getBranchTipSnapshot(
  repoId: string,
  storageKey: string,
  branch: string,
  sourceFile: string,
): Promise<SnapshotWithEntities | null> {
  const shaList = await branchShas(storageKey, branch);
  for (const sha of shaList) {
    const snap = await prisma.snapshot.findFirst({
      where: { repoId, sourceFile, gitCommitSha: sha },
      include: { entities: { orderBy: { path: "asc" } } },
    });
    if (snap) return snap;
  }
  return prisma.snapshot.findFirst({
    where: { repoId, sourceFile },
    orderBy: { createdAt: "desc" },
    include: { entities: { orderBy: { path: "asc" } } },
  });
}

export async function materializeResolvedFiles(
  repoId: string,
  storageKey: string,
  toBranch: string,
  fromBranch: string,
  fileResolutions: MergeFileResolution[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const fileRes of fileResolutions) {
    const { sourceFile } = fileRes;
    const baseSnap = await getBranchTipSnapshot(repoId, storageKey, toBranch, sourceFile);
    const incSnap = await getBranchTipSnapshot(repoId, storageKey, fromBranch, sourceFile);
    if (!baseSnap || !incSnap || baseSnap.handlerId !== incSnap.handlerId) continue;

    if ("hunks" in fileRes && baseSnap.handlerId === PLAIN_TEXT_HANDLER_ID) {
      const baseBody = baseSnap.snapshotBody ?? (await readFileAtBranch(storageKey, toBranch, sourceFile)) ?? "";
      const incBody = incSnap.snapshotBody ?? (await readFileAtBranch(storageKey, fromBranch, sourceFile)) ?? "";
      const diff = comparePlainTextSnapshots(baseSnap.id, incSnap.id, baseBody, incBody);
      const hunkSides: Record<string, TextHunkSide> = {};
      for (const h of fileRes.hunks) hunkSides[h.hunkId] = h.side;
      const known = new Set(groupPlainTextHunks(diff.lines).map((h) => h.id));
      for (const h of fileRes.hunks) {
        if (!known.has(h.hunkId)) throw new Error(`Unknown hunk '${h.hunkId}' for ${sourceFile}`);
      }
      out[sourceFile] = materializePlainTextMerge(diff.lines, hunkSides);
      continue;
    }

    if (baseSnap.handlerId === GLTF_SCENE_HANDLER_ID && ("entities" in fileRes || "fields" in fileRes)) {
      const baseJson = await readFileAtBranch(storageKey, toBranch, sourceFile);
      const incJson = await readFileAtBranch(storageKey, fromBranch, sourceFile);
      if (!baseJson || !incJson) continue;

      const diff = await gltfSceneHandler.diff(Buffer.from(baseJson), Buffer.from(incJson));
      const entitySides: Record<string, MergeSide> = {};
      const fieldSides: Record<string, MergeSide> = {};
      for (const e of fileRes.entities ?? []) entitySides[e.entityId] = e.side;
      for (const f of fileRes.fields ?? []) fieldSides[`${f.entityId}:${f.field}`] = f.side;

      const fieldChangesByEntity = new Map<string, Array<{ field: string }>>();
      for (const c of diff.changes) {
        if (c.kind === "modified" && c.children && c.children.length > 0) {
          const payload = (c.before ?? c.after) as { entityId?: string } | null;
          if (payload?.entityId) {
            fieldChangesByEntity.set(payload.entityId, c.children.map((ch) => ({ field: ch.path })));
          }
        }
      }

      out[sourceFile] = materializeGltfMerge(
        baseJson,
        incJson,
        baseSnap.entities,
        incSnap.entities,
        entitySides,
        fieldSides,
        fieldChangesByEntity,
      );
    }
  }

  return out;
}

export async function resolvePullRequestMerge(
  storageKey: string,
  repoId: string,
  toBranch: string,
  fromBranch: string,
  message: string,
  options:
    | { strategy: "ours" | "theirs" }
    | { files: MergeFileResolution[] },
): Promise<MergeResult> {
  if ("strategy" in options) {
    return performMerge(storageKey, fromBranch, toBranch, message, options.strategy);
  }

  const resolved = await materializeResolvedFiles(repoId, storageKey, toBranch, fromBranch, options.files);
  if (Object.keys(resolved).length === 0) {
    return performMerge(storageKey, fromBranch, toBranch, message);
  }

  const allChanged = await listFilesDifferingBetweenBranches(storageKey, toBranch, fromBranch);
  for (const p of allChanged) {
    if (!(p in resolved)) {
      const ours = await readFileAtBranch(storageKey, toBranch, p);
      if (ours !== null) resolved[p] = ours;
    }
  }

  return performMergeWithResolvedFiles(storageKey, fromBranch, toBranch, message, resolved);
}
