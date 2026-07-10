import { useEffect, useRef, useState } from "react";
import type { FileDiffViewerProps } from "../fileDiffViewerTypes";
import { getFileSemanticDiff } from "../../api";
import { loadRendererBundle, type RendererInstance } from "../../lib/rendererBundle";

type Status = "loading" | "ready" | "empty" | "error";

/**
 * Renders a format-aware diff for a binary file (e.g. glTF) by fetching the
 * server-computed StructuredDiff and mounting the format's FHR renderer bundle
 * — instead of the "no diff viewer registered" fallback. The rich native 3D
 * workspace is unaffected; this upgrades the commit/PR file view only.
 */
export function SceneFileDiffViewer({ file, repoBase, headRef, token }: FileDiffViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<RendererInstance | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  // repoBase is "/handle/repo"
  const [, handle, repoName] = repoBase.split("/");

  useEffect(() => {
    let cancelled = false;
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
        const bundle = await loadRendererBundle(diff.handlerId);
        if (cancelled || !hostRef.current) return;
        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
        instRef.current = bundle.mount(hostRef.current, {
          mode: "diff",
          diff,
          theme: dark ? "dark" : "light",
        });
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setMessage(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      instRef.current?.unmount();
      instRef.current = null;
    };
  }, [token, handle, repoName, path, headRef]);

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
