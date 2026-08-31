import { useEffect, useRef, useState } from "react";
import { API_BASE, fetchRawBlob } from "../../api";
import { loadSemanticFormats } from "../../lib/fhrFormats";
import { loadRendererBundle } from "../../lib/rendererBundle";
import type { RendererInstance } from "../../lib/rendererBundle";
import type { FileViewerProps } from "../fileViewerTypes";

/**
 * Standalone (non-diff) view for files the FHR manifest maps to a handler:
 * fetches the raw blob and mounts the handler's renderer bundle in
 * `mode: "view"` — the same bundle the diff view uses, minus the diff.
 *
 * Everything that can go wrong (manifest gap, bundle load failure, mount
 * throw, blob 404) degrades to an honest binary-file card with a download
 * button. The one thing this viewer exists to prevent is the previous
 * behavior: model bytes decoded as a string and rendered as mojibake.
 */

/**
 * Above this size the bytes are fetched only after an explicit click, with the
 * real cost on the button — the same honest-cost principle as the Tier B
 * consent gate. Below it the model just loads: a click-through on every small
 * file would tax the common case to protect the rare one.
 */
export const VIEW_AUTO_LOAD_MAX_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Repo coordinates out of `repoBase` ("/alice/repo"). */
function parseRepoBase(repoBase: string): { handle: string; repoName: string } | null {
  const parts = repoBase.replace(/^\//, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { handle: parts[0], repoName: parts[1] };
}

type Phase =
  | { kind: "loading" }
  | { kind: "gate"; size: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function FhrFileViewer({ path, filename, gitRef, repoBase, token }: FileViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<RendererInstance | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Consent is keyed to the exact file — a bare boolean survives blob→blob
  // navigation (this component stays mounted across splat changes) and one
  // click would unlock every later large file. Derived, so no reset effect
  // can race the fetch effect.
  const fileKey = `${gitRef}:${path}`;
  const [consentedKey, setConsentedKey] = useState<string | null>(null);
  const consented = consentedKey === fileKey;

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
      // Size first, bytes second: the auto-load ceiling needs the size BEFORE
      // the download it exists to gate. /rawblob answers HEAD from its
      // pre-flight without spawning git for the body.
      const headRes = await fetch(
        `${API_BASE}/repos/${repo.handle}/${repo.repoName}/rawblob?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(gitRef)}`,
        { method: "HEAD", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (cancelled) return;
      if (!headRes.ok) {
        setPhase({
          kind: "error",
          message:
            headRes.status === 404
              ? "File not found at this ref."
              : `Could not load the file (HTTP ${headRes.status}).`,
        });
        return;
      }
      const size = Number(headRes.headers.get("content-length") ?? 0);
      if (size > VIEW_AUTO_LOAD_MAX_BYTES && !consented) {
        setPhase({ kind: "gate", size });
        return;
      }

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
  }, [repo?.handle, repo?.repoName, path, filename, gitRef, token, consented]);

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

  if (phase.kind === "gate") {
    return (
      <div className="p-12 text-center text-fh-fg-muted">
        <p className="text-fh-sm font-medium text-fh-fg">
          This file is {formatBytes(phase.size)} — larger than the {formatBytes(VIEW_AUTO_LOAD_MAX_BYTES)} auto-load ceiling.
        </p>
        <button
          type="button"
          onClick={() => setConsentedKey(fileKey)}
          className="mt-3 inline-flex items-center h-7 px-3 text-fh-sm rounded-md border border-fh-border bg-fh-surface text-fh-fg hover:bg-fh-surface-muted cursor-pointer"
        >
          Load 3D view ({formatBytes(phase.size)})
        </button>
      </div>
    );
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
