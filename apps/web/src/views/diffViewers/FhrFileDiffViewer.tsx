import { useEffect, useRef, useState } from "react";
import type { FileDiffViewerProps } from "../fileDiffViewerTypes";
import { fetchRawBlob, getFileSemanticDiff, isFormatNotSupported, type SemanticFileDiff } from "../../api";
import { loadRendererBundle, type RendererInstance } from "../../lib/rendererBundle";
import { resolveBaseFileDiffViewer } from "../fileDiffViewerRegistry";

type Status = "loading" | "ready" | "empty" | "error" | "fallback";

// The blob envelope a renderer receives (SPEC-RENDERING §2b, @fhr/types
// RendererBlobs). Declared locally so the web app needs no build-time dep on
// the FHR packages — the bundle is loaded at runtime from the API proxy.
type BlobRef = { url: string; size: number };
type RendererBlobs = { base?: BlobRef; head?: BlobRef };

/**
 * Manifest-driven semantic diff viewer for a single file. It is fully generic:
 * it serves EVERY format the FHR manifest advertises — glTF today, and whatever
 * a future handler adds — with no per-format code. ForgeHub knows only the
 * mount() renderer contract and StructuredDiff; all format knowledge lives in
 * the renderer bundle and the API's manifest.
 *
 * It fetches the server-computed StructuredDiff for the blob pair, loads the
 * format's FHR renderer bundle by diff.handlerId, and mounts it — replacing the
 * plain text/binary diff for that file. The rich native workspace is unaffected;
 * this upgrades the commit/PR file view only.
 *
 * Graceful degradation: if the repo hasn't opted this format in / no handler is
 * registered, /filediff answers 404 and we render exactly what the file would
 * have shown WITHOUT semantic support — its base text/binary viewer — instead of
 * an error. Only genuine failures (500, network) surface the error line.
 *
 * The renderer's optional geometry/"View in 3D" scene needs the actual file
 * bytes, so we also fetch the base/head raw blobs (auth-aware) and hand the
 * renderer object URLs for them — the renderer fetch()es those without an
 * Authorization header. Object URLs are revoked on teardown so they don't leak.
 */
export function FhrFileDiffViewer({ file, repoBase, headRef, token }: FileDiffViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<RendererInstance | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  const filename = path.split("/").pop() ?? path;
  // repoBase is "/handle/repo"
  const [, handle, repoName] = repoBase.split("/");

  useEffect(() => {
    let cancelled = false;
    // Object URLs created for this mount; revoked on teardown so they don't leak.
    const objectUrls: string[] = [];
    const revokeAll = () => {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.length = 0;
    };
    setStatus("loading");
    setMessage("");

    (async () => {
      try {
        const diff = await getFileSemanticDiff(token, handle, repoName, path, headRef);
        if (cancelled) return;
        if (!diff.changes || diff.changes.length === 0) {
          setStatus("empty");
          return;
        }

        // Best-effort: the change tree renders even if the blobs are missing;
        // only the on-demand geometry scene needs them.
        const blobs = await loadRendererBlobs(token, handle, repoName, path, diff, objectUrls);
        if (cancelled) return revokeAll();

        const bundle = await loadRendererBundle(diff.handlerId);
        if (cancelled || !hostRef.current) return revokeAll();

        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
        instRef.current = bundle.mount(hostRef.current, {
          mode: "diff",
          diff,
          blobs,
          theme: dark ? "dark" : "light",
        });
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        // The repo hasn't opted this format in (no handler / not enabled): show
        // exactly what the file would have shown without semantic support,
        // rather than an error.
        if (isFormatNotSupported(e)) {
          setStatus("fallback");
          return;
        }
        setMessage(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      instRef.current?.unmount();
      instRef.current = null;
      revokeAll();
    };
  }, [token, handle, repoName, path, headRef]);

  // 404 fallback: render the base (text/binary) viewer this file would have used
  // without semantic support — no extra chrome, so it looks identical.
  if (status === "fallback") {
    const BaseViewer = resolveBaseFileDiffViewer(filename);
    return <BaseViewer file={file} repoBase={repoBase} headRef={headRef} token={token} />;
  }

  return (
    <div className="px-4 py-3">
      {status === "loading" && <p className="text-sm text-gh-muted italic">Computing semantic diff…</p>}
      {status === "empty" && <p className="text-sm text-gh-muted italic">No semantic changes detected.</p>}
      {status === "error" && (
        <p className="text-sm text-gh-muted italic">Semantic diff unavailable: {message}</p>
      )}
      <div ref={hostRef} style={{ display: status === "ready" ? "block" : "none" }} />
    </div>
  );
}

/**
 * Fetch the base/head raw blobs for a diff and return them as object-URL refs
 * the renderer can consume. Each fetch is independent and non-fatal — a deleted
 * file has no head blob, an added file no base blob, and a private-repo miss
 * shouldn't sink the change tree. Created URLs are appended to `objectUrls` so
 * the caller can revoke them on teardown.
 */
async function loadRendererBlobs(
  token: string | null,
  handle: string,
  repoName: string,
  path: string,
  diff: SemanticFileDiff,
  objectUrls: string[],
): Promise<RendererBlobs> {
  const toRef = async (sha: string | null): Promise<BlobRef | undefined> => {
    if (!sha) return undefined;
    try {
      const blob = await fetchRawBlob(token, handle, repoName, path, sha);
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      return { url, size: blob.size };
    } catch {
      return undefined;
    }
  };
  const [head, base] = await Promise.all([toRef(diff.headSha), toRef(diff.baseSha)]);
  const blobs: RendererBlobs = {};
  if (head) blobs.head = head;
  if (base) blobs.base = base;
  return blobs;
}
