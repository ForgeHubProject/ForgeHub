import { useEffect, useRef, useState } from "react";
import type { FileDiffViewerProps } from "../fileDiffViewerTypes";
import { fetchRawBlob, getFileSemanticDiff, isFormatNotSupported, type SemanticFileDiff } from "../../api";
import { loadRendererBundle, type RendererInstance } from "../../lib/rendererBundle";
import { browserWasmDiff } from "../../lib/browserWasm";
import { TIER_S_SLOW_MS, assessBrowserTier, type ComputeTier } from "../../lib/computeTier";
import {
  BrowserComputeGate,
  BuildMismatchBanner,
  LocalHandoffPanel,
  SlowServerNudge,
  useFileDiffMeta,
} from "./computeTierUi";
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
 * The diff can be computed by any tier (issue #66 P4, SPEC-RENDERING §4); the
 * tier arrives from the diff-header pill via `computeTier`:
 *
 *   S — server (default, canonical): fetch the server-computed StructuredDiff,
 *       exactly the pre-P4 path. If the request drags past the latency
 *       threshold, a nudge offers the client tiers instead of a bare spinner.
 *   B — browser: after an explicit honest-cost consent, download BOTH raw
 *       blobs, run the official handler's wasm build in this tab, and mount
 *       the same renderer on the result. Capability-gated; build skew against
 *       the repo's .forge/handlers pin is bannered loudly, never silent.
 *   L — local: no compute at all — a copyable `forge diff --web` command hands
 *       the diff to the user's own forge; zero bytes leave ForgeHub.
 *
 * Graceful degradation: if the repo hasn't opted this format in / no handler is
 * registered, /filediff answers 404 and we render exactly what the file would
 * have shown WITHOUT semantic support — its base text/binary viewer — instead of
 * an error. Only genuine failures (500, network) surface the error line.
 *
 * The renderer's optional geometry/"View in 3D" scene needs the actual file
 * bytes, so the server path also fetches the base/head raw blobs (auth-aware)
 * and hands the renderer object URLs for them; the browser path reuses the very
 * blobs it computed from. Object URLs are revoked on teardown so they don't
 * leak.
 */
export function FhrFileDiffViewer({
  file,
  repoBase,
  headRef,
  token,
  computeTier,
  onComputeTierChange,
}: FileDiffViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<RendererInstance | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  // Tier-S request in flight past the threshold → show the reactive nudge.
  const [slow, setSlow] = useState(false);
  // Tier B computes only after the honest-cost gate is clicked (per mount).
  const [browserConsented, setBrowserConsented] = useState(false);

  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  const filename = path.split("/").pop() ?? path;
  // repoBase is "/handle/repo"
  const [, handle, repoName] = repoBase.split("/");

  // Uncontrolled fallback so the nudge still works where no header pill owns
  // the tier; when a parent passes computeTier, its value wins.
  const [localTier, setLocalTier] = useState<ComputeTier>("server");
  const tier = computeTier ?? localTier;
  const changeTier = (t: ComputeTier) => {
    setLocalTier(t);
    onComputeTierChange?.(t);
  };

  // Shared with the header pill (cached — one request per blob pair): SHAs and
  // sizes for tiers B/L, capability detection, and the build-pin check.
  const meta = useFileDiffMeta(token, repoBase, path, headRef);

  const browserReady =
    tier === "browser" && browserConsented && meta !== null && assessBrowserTier(meta).available;

  // Read by the effect through a ref so meta's null→loaded transition doesn't
  // re-run (and re-fetch) a server-tier diff that never needed it; the browser
  // tier is already re-triggered by `browserReady`, which implies meta loaded.
  const metaRef = useRef(meta);
  metaRef.current = meta;

  useEffect(() => {
    // Tier L renders a hand-off panel, no compute. Tier B waits for consent.
    if (tier === "local" || (tier === "browser" && !browserReady)) return;

    let cancelled = false;
    // Object URLs created for this mount; revoked on teardown so they don't leak.
    const objectUrls: string[] = [];
    const revokeAll = () => {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.length = 0;
    };
    setStatus("loading");
    setMessage("");
    setSlow(false);
    // The nudge replaces the spinner only for the server tier — a slow browser
    // compute is the user's own machine, with its cost already consented to.
    const slowTimer =
      tier === "server" ? window.setTimeout(() => setSlow(true), TIER_S_SLOW_MS) : undefined;

    (async () => {
      try {
        let diff: SemanticFileDiff;
        let blobs: RendererBlobs;

        const meta = metaRef.current;
        if (tier === "browser" && meta) {
          // Tier B: both blobs down, wasm computes here. The blobs double as
          // the renderer's geometry sources — no second download.
          const [base, head] = await Promise.all([
            meta.baseSha ? fetchRawBlob(token, handle, repoName, path, meta.baseSha) : null,
            fetchRawBlob(token, handle, repoName, path, meta.headSha),
          ]);
          if (cancelled) return;
          const [baseBytes, headBytes] = await Promise.all([
            base ? base.arrayBuffer().then((b) => new Uint8Array(b)) : new Uint8Array(0),
            head.arrayBuffer().then((b) => new Uint8Array(b)),
          ]);
          if (cancelled) return;
          const computed = await browserWasmDiff(meta.handlerId, baseBytes, headBytes);
          diff = { ...computed, handlerId: meta.handlerId, path, baseSha: meta.baseSha, headSha: meta.headSha };
          blobs = {};
          if (base) {
            const url = URL.createObjectURL(base);
            objectUrls.push(url);
            blobs.base = { url, size: base.size };
          }
          const headUrl = URL.createObjectURL(head);
          objectUrls.push(headUrl);
          blobs.head = { url: headUrl, size: head.size };
        } else {
          // Tier S: the canonical server-computed diff (the record for review).
          diff = await getFileSemanticDiff(token, handle, repoName, path, headRef);
          if (cancelled) return;
          // Best-effort: the change tree renders even if the blobs are missing;
          // only the on-demand geometry scene needs them.
          blobs = await loadRendererBlobs(token, handle, repoName, path, diff, objectUrls);
        }
        if (cancelled) return revokeAll();

        if (!diff.changes || diff.changes.length === 0) {
          revokeAll();
          setStatus("empty");
          return;
        }

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
      } finally {
        if (slowTimer !== undefined) window.clearTimeout(slowTimer);
        if (!cancelled) setSlow(false);
      }
    })();

    return () => {
      cancelled = true;
      if (slowTimer !== undefined) window.clearTimeout(slowTimer);
      instRef.current?.unmount();
      instRef.current = null;
      revokeAll();
    };
  }, [token, handle, repoName, path, headRef, tier, browserReady]);

  // 404 fallback: render the base (text/binary) viewer this file would have used
  // without semantic support — no extra chrome, so it looks identical.
  if (status === "fallback") {
    const BaseViewer = resolveBaseFileDiffViewer(filename);
    return <BaseViewer file={file} repoBase={repoBase} headRef={headRef} token={token} />;
  }

  // Tier L: the forge hand-off (needs meta for the SHAs in the command).
  if (tier === "local") {
    return meta ? (
      <LocalHandoffPanel meta={meta} />
    ) : (
      <div className="px-4 py-3">
        <p className="text-sm text-gh-muted italic">Resolving revisions…</p>
      </div>
    );
  }

  // Tier B, pre-compute: capability + honest-cost gate.
  if (tier === "browser" && !browserReady) {
    if (!meta) {
      return (
        <div className="px-4 py-3">
          <p className="text-sm text-gh-muted italic">Checking browser-compute capability…</p>
        </div>
      );
    }
    const assessment = assessBrowserTier(meta);
    if (!assessment.available) {
      return (
        <div className="px-4 py-3">
          <p className="text-sm text-gh-muted italic">
            Browser compute unavailable: {assessment.reason}. Switch the tier pill to use the server
            diff.
          </p>
        </div>
      );
    }
    return <BrowserComputeGate meta={meta} onCompute={() => setBrowserConsented(true)} />;
  }

  return (
    <div className="px-4 py-3">
      {/* Tier B renders against whatever build the proxy serves — if the repo
          pins a different one, that skew stays visible above the result. */}
      {tier === "browser" && meta && status !== "loading" && <BuildMismatchBanner meta={meta} />}
      {status === "loading" &&
        (tier === "server" && slow ? (
          <SlowServerNudge meta={meta} onSwitch={changeTier} />
        ) : (
          <p className="text-sm text-gh-muted italic">
            {tier === "browser" ? "Computing in your browser…" : "Computing semantic diff…"}
          </p>
        ))}
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
