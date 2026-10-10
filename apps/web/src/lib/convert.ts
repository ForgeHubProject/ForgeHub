import { fetchConverted, fetchConvertFormats, type ConvertFormat } from "../api";

// Converting a 3D file to another format (FHR SPEC §7): the server pivots through
// glTF, so any format whose handler can import can be written as any whose handler
// can export. This module decides what to offer for a file and runs a conversion.

let formats: Promise<ConvertFormat[]> | null = null;

/** Test hook: forget the memoized format list. */
export function __resetConvertFormats(): void {
  formats = null;
}

/**
 * The server's convertible formats, fetched once per session. A failure is
 * remembered as "none" for the session so a server without the endpoint (an
 * older ForgeHub) costs one request, not one per file.
 */
export function loadConvertFormats(fetchImpl: typeof fetchConvertFormats = fetchConvertFormats): Promise<ConvertFormat[]> {
  formats ??= fetchImpl().catch(() => []);
  return formats;
}

/** A file name's extension, lowercased with its dot ("" when it has none). */
export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i).toLowerCase() : "";
}

/**
 * The extensions a file can be converted to: none unless its own format can be
 * imported, otherwise every other format that can be exported. Sorted, so the
 * menu order does not depend on manifest order.
 */
export function convertTargets(all: ConvertFormat[], filename: string): string[] {
  const ext = extOf(filename);
  if (!all.some((f) => f.ext === ext && f.canImport)) return [];
  return all.filter((f) => f.canExport && f.ext !== ext).map((f) => f.ext).sort();
}

/** The converted file's name: the original with its extension swapped. */
export function convertedName(filename: string, to: string): string {
  const ext = extOf(filename);
  return `${ext ? filename.slice(0, -ext.length) : filename}${to}`;
}

/** Hand bytes to the browser as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Convert and save the result under the converted name. */
export async function downloadConverted(
  token: string | null,
  handle: string,
  repoName: string,
  filePath: string,
  sha: string,
  to: string,
  fetchImpl: typeof fetchConverted = fetchConverted,
  save: typeof saveBlob = saveBlob,
): Promise<void> {
  const blob = await fetchImpl(token, handle, repoName, filePath, sha, to);
  save(blob, convertedName(filePath.split("/").pop() ?? filePath, to));
}
