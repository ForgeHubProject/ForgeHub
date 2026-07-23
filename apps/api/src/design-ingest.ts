import { createHash } from "node:crypto";
import { extname } from "node:path";
import { firstHandlerForPath } from "./handlers/index.js";
import type { ArtifactHandler } from "./handlers/types.js";

/**
 * Design management (issue #121) ingestion helpers.
 *
 * Designs attach to issues and are NOT commit-scoped, so — unlike the push-time
 * ingest pipeline — there is no `.forge/formats` opt-in to consult. Handler
 * eligibility is resolved straight from the global registry by file extension:
 * whatever handler claims the design's file name serves it. This keeps the
 * flagship synergy (semantic version-vs-version diffs) available for any
 * FHR-recognized attachment without a per-repo opt-in step.
 */

/** Image formats that get a visual (before/after) compare rather than a semantic one. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** The handler (if any) that claims a design's file name, by extension via the registry. */
export function designHandlerFor(name: string): ArtifactHandler | undefined {
  return firstHandlerForPath(name);
}

/** True when a design file is a browser-renderable image (visual-diff eligible). */
export function isImageName(name: string, contentType?: string | null): boolean {
  if (contentType && contentType.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTS.has(extname(name).toLowerCase());
}

/**
 * Ingest a design file's bytes into a Snapshot if an FHR handler claims its name.
 * Reuses the exact same `handler.ingestFromUtf8Text` pipeline that push-time
 * ingestion and the /snapshots route use — no duplicated parse/persist logic.
 * Returns the new snapshot id, or null when the format is unrecognized or the
 * bytes could not be ingested (e.g. a binary .glb or malformed JSON): such files
 * still store fine, just without an entity tree.
 */
export async function ingestDesignSnapshot(params: {
  repoId: string;
  name: string;
  buffer: Buffer;
}): Promise<string | null> {
  const handler = designHandlerFor(params.name);
  if (!handler) return null;
  try {
    return await handler.ingestFromUtf8Text({
      repoId: params.repoId,
      sourceFile: params.name,
      utf8Text: params.buffer.toString("utf8"),
      label: null,
      gitCommitSha: null,
    });
  } catch {
    // Unrecognized/opaque payload for this handler — keep the file, drop the tree.
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
