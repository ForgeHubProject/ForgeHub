import type { BlobMeta } from "../api";

/**
 * What a file page draws under its header.
 *
 * - "pending": the facts that decide it are still loading.
 * - "renderer": a format renderer draws the file (a model, a notebook).
 * - "text": the file's text, by the static viewers (code, markdown).
 * - "latest-change": a binary file whose format has semantic diffs, but whose
 *   renderer draws diffs only (a .figcraft design): there is no text to show,
 *   so the page shows what its latest commit changed.
 * - "binary": any other binary file: its size and a download, never its bytes
 *   decoded as text.
 */
export type FileBody = "pending" | "renderer" | "text" | "latest-change" | "binary";

/**
 * `meta` is the blob's facts: undefined while they load, null when they could
 * not be had (the page then shows text, as it did before it knew).
 */
export function fileBody(f: {
  semantic: boolean;
  manifestSettled: boolean;
  meta: Pick<BlobMeta, "binary" | "format"> | null | undefined;
}): FileBody {
  if (f.semantic) return "renderer";
  if (!f.manifestSettled || f.meta === undefined) return "pending";
  if (f.meta?.binary) return f.meta.format?.semanticDiffs ? "latest-change" : "binary";
  return "text";
}
