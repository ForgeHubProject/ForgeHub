import { createHash } from "node:crypto";
import { extname } from "node:path";
import { officialHandlerId } from "./fhr/official-handlers.js";
import { ingestSceneSnapshot } from "./fhr-entities.js";

/**
 * Design management (issue #121) ingestion helpers.
 *
 * Designs attach to issues and are NOT commit-scoped, so — unlike the push-time
 * ingest pipeline — there is no `.forge/formats` opt-in to consult: a design is
 * read by the official FHR handler for its extension, whatever the repo opted
 * into. That keeps semantic version-vs-version diffs available for any format
 * FHR reads (#74: FHR, not a ForgeHub-owned parser, is the engine).
 */

/** Image formats that get a visual (before/after) compare rather than a semantic one. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** The official FHR handler that reads a design's file, by extension; null when none does. */
export async function designHandlerId(name: string): Promise<string | null> {
  try {
    return await officialHandlerId(extname(name).toLowerCase());
  } catch {
    return null; // manifest unreachable: no semantic claim we can stand behind
  }
}

/** True when a design file is a browser-renderable image (visual-diff eligible). */
export function isImageName(name: string, contentType?: string | null): boolean {
  if (contentType && contentType.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTS.has(extname(name).toLowerCase());
}

/**
 * Whether a design is compared semantically. An image is compared by eye, side
 * by side — FHR's image handlers read only metadata, and that tree is no
 * substitute for the picture — so it stays visual even though a handler exists.
 */
export async function designIsSemantic(name: string): Promise<boolean> {
  return !isImageName(name) && (await designHandlerId(name)) !== null;
}

/**
 * Record a snapshot of a design version as its official handler reads it: the
 * scene entities for search, and — by existing at all — the mark that this
 * version can be diffed semantically. Returns the snapshot id, or null when no
 * official handler takes the format or it could not read the bytes (e.g. a
 * malformed glTF): such files still store fine, without one.
 */
export async function ingestDesignSnapshot(params: {
  repoId: string;
  name: string;
  buffer: Buffer;
}): Promise<string | null> {
  if (isImageName(params.name)) return null; // compared visually: see designIsSemantic
  try {
    return await ingestSceneSnapshot({
      repoId: params.repoId,
      sourceFile: params.name,
      bytes: params.buffer,
      label: null,
      gitCommitSha: null,
      keepEmpty: true,
    });
  } catch {
    return null;
  }
}

/**
 * Git blob object hash of a buffer (`sha1("blob <len>\0" + bytes)`), matching
 * `git hash-object`. Used as the DiffCache key for design compares so the cache
 * is keyed identically to the PR/commit compare path (routes/compare.ts) — the
 * same file bytes yield the same cache entry regardless of how they arrived.
 */
export function gitBlobSha(buffer: Buffer): string {
  return createHash("sha1")
    .update("blob ")
    .update(String(buffer.length))
    .update("\0")
    .update(buffer)
    .digest("hex");
}
