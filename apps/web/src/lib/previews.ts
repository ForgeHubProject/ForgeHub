import { fetchPreview } from "../api";

// Handler previews for renderers (FHR SPEC §7 `preview`, @fhr/types
// MountProps.previews). A handler whose format the browser cannot draw from
// its own bytes — OBJ — converts each side into one it can (a GLB whose node
// names are the diff's paths), and its renderer draws that instead of the raw
// blob. Declared locally, like the rest of the renderer envelope, so the web
// app needs no build-time dependency on the FHR packages.

export type BlobRef = { url: string; size: number };
export type RendererBlobs = { base?: BlobRef; head?: BlobRef };

// Handlers the API has said have no preview (`code: "no-preview"`), so a blob
// view of, say, a .glb asks once per session rather than once per file.
const noPreview = new Set<string>();

/** Test hook: forget which handlers had no preview. */
export function __resetPreviewMemo(): void {
  noPreview.clear();
}

/**
 * Fetch the server-computed preview of each given side and return object-URL
 * refs for the renderer. Best-effort by design: the change tree renders
 * without previews, and a renderer MUST degrade when they are absent, so any
 * failure leaves that side out rather than failing the view. Created URLs are
 * appended to `objectUrls` for the caller to revoke.
 */
export async function loadServerPreviews(
  token: string | null,
  handle: string,
  repoName: string,
  path: string,
  shas: { base?: string | null; head?: string | null },
  handlerId: string | null,
  objectUrls: string[],
  fetchImpl: typeof fetchPreview = fetchPreview,
): Promise<RendererBlobs | undefined> {
  if (handlerId && noPreview.has(handlerId)) return undefined;
  const side = async (sha: string | null | undefined): Promise<BlobRef | undefined> => {
    if (!sha) return undefined;
    try {
      const res = await fetchImpl(token, handle, repoName, path, sha);
      if (res.kind === "none") {
        const id = res.handlerId ?? handlerId;
        if (id) noPreview.add(id);
        return undefined;
      }
      const url = URL.createObjectURL(res.blob);
      objectUrls.push(url);
      return { url, size: res.blob.size };
    } catch {
      return undefined;
    }
  };
  const [base, head] = await Promise.all([side(shas.base), side(shas.head)]);
  if (!base && !head) return undefined;
  return { ...(base ? { base } : {}), ...(head ? { head } : {}) };
}

/** Wrap in-browser preview bytes (Tier B) as an object-URL ref. */
export function previewRef(bytes: Uint8Array, mediaType: string, objectUrls: string[]): BlobRef {
  const blob = new Blob([bytes as BlobPart], { type: mediaType });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return { url, size: blob.size };
}
