import { useEffect, useRef, useState } from "react";
import { fetchRawBlob } from "../../api";
import { loadSemanticFormats } from "../../lib/fhrFormats";
import { loadRendererBundle } from "../../lib/rendererBundle";
import type { RendererInstance } from "../../lib/rendererBundle";
import type { FileViewerProps } from "../fileViewerTypes";

/**
 * Standalone (non-diff) view for files the FHR manifest maps to a handler:
 * fetches the raw blob and mounts the handler's renderer bundle in
 * `mode: "view"` — the same bundle the diff view uses, minus the diff.
 *
 * There is deliberately NO size ceiling here. A file of any size loads and
 * renders — serving large models is the product's point, and /rawblob streams
 * without a cap for exactly that reason (#157). An earlier revision put a
 * 25 MiB consent gate in front of the fetch; it read as "ForgeHub can't show
 * this file", which is the impression the whole pipeline exists to avoid.
 *
 * Everything that can go wrong (manifest gap, bundle load failure, mount
 * throw, blob 404) degrades to an honest binary-file card with a download
 * button. The one thing this viewer exists to prevent is the previous
 * behavior: model bytes decoded as a string and rendered as mojibake.
 */

/** Repo coordinates out of `repoBase` ("/alice/repo"). */
function parseRepoBase(repoBase: string): { handle: string; repoName: string } | null {
  const parts = repoBase.replace(/^\//, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { handle: parts[0], repoName: parts[1] };
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function FhrFileViewer({ path, filename, gitRef, repoBase, token }: FileViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<RendererInstance | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const repo = parseRepoBase(repoBase ?? "");

  useEffect(() => {
    if (!repo) {
      setPhase({ kind: "error", message: "Missing repository context for this file." });
      return;
    }
    let cancelled = false;
    const objectUrls: string[] = [];
    const revokeAll = () => {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.length = 0;
    };
    setPhase({ kind: "loading" });

    (async () => {
      const [blob, formats] = await Promise.all([
        fetchRawBlob(token ?? null, repo.handle, repo.repoName, path, gitRef),
        loadSemanticFormats(),
      ]);
      if (cancelled) return;

      const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
      const handlerId = formats.get(ext);
      if (!handlerId) {
        // Routed here by an extension set the formats map no longer backs —
        // possible only across a manifest refresh. The card is still honest.
        setPhase({ kind: "error", message: `No FHR handler is registered for .${ext} files.` });
        return;
      }

      const bundle = await loadRendererBundle(handlerId);
      if (cancelled || !hostRef.current) return revokeAll();

      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
      instRef.current = bundle.mount(hostRef.current, {
        mode: "view",
        blobs: { head: { url, size: blob.size } },
        theme: dark ? "dark" : "light",
      });
      setPhase({ kind: "ready" });
    })().catch((e) => {
      if (cancelled) return;
      revokeAll();
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });

    return () => {
      cancelled = true;
      instRef.current?.unmount();
      instRef.current = null;
      revokeAll();
    };
    // repo is derived from repoBase; using its parts keeps the deps primitive.
  }, [repo?.handle, repo?.repoName, path, filename, gitRef, token]);

  async function download() {
    if (!repo) return;
    const blob = await fetchRawBlob(token ?? null, repo.handle, repo.repoName, path, gitRef);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (phase.kind === "error") {
    return (
      <div className="p-12 text-center text-fh-fg-muted">
        <p className="text-fh-sm font-medium text-fh-fg">Cannot display this file.</p>
        <p className="text-fh-xs mt-1.5">{phase.message}</p>
        <button
          type="button"
          onClick={() => void download()}
          className="mt-3 inline-flex items-center h-7 px-3 text-fh-sm rounded-md border border-fh-border bg-fh-surface text-fh-fg hover:bg-fh-surface-muted cursor-pointer"
        >
          Download {filename}
        </button>
      </div>
    );
  }

  return (
    <div>
      {phase.kind === "loading" && (
        <div className="p-12 text-center text-fh-sm text-fh-fg-muted">Loading viewer…</div>
      )}
      {/* The bundle owns everything inside this element. */}
      <div ref={hostRef} />
    </div>
  );
}
