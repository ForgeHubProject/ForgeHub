import { useCallback, useEffect, useState } from "react";
import { getFileDiffMeta, type FileDiffMeta } from "../../api";
import {
  TIER_LABELS,
  assessBrowserTier,
  browserDownloadLabel,
  buildMismatch,
  forgeDiffCommand,
  resolveTierPreference,
  setGlobalTierPreference,
  setTierPreference,
  type ComputeTier,
  type TierBAssessment,
} from "../../lib/computeTier";
import { DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, Tooltip, cx } from "../../ui";

// Chrome for the compute-tier choice on semantic diffs (issue #66 P4). The
// decisions live in lib/computeTier.ts; this file is only the pill on the diff
// header, the pieces the viewer swaps in per tier (browser-compute gate, local
// hand-off, slow-server nudge), and the loud build-mismatch banner they share.

// ─── state hooks ────────────────────────────────────────────────────────────────

/**
 * The compute tier for one format: starts from the sticky preference
 * (per-format, then the global setting, then Tier S) and persists the
 * per-format choice on change. `allFormats` also sets the global default —
 * the pill's "use for all formats" action.
 */
export function useComputeTier(ext: string): [ComputeTier, (t: ComputeTier, opts?: { allFormats?: boolean }) => void] {
  const [tier, setTier] = useState<ComputeTier>(() => resolveTierPreference(ext));
  const change = useCallback(
    (t: ComputeTier, opts?: { allFormats?: boolean }) => {
      setTier(t);
      setTierPreference(ext, t);
      if (opts?.allFormats) setGlobalTierPreference(t);
    },
    [ext],
  );
  return [tier, change];
}

// One meta fetch per blob pair, shared by the header pill and the viewer body
// so switching tiers never re-asks the server. A rejection is not cached, so a
// later mount retries.
const metaCache = new Map<string, Promise<FileDiffMeta>>();

function fetchMetaOnce(
  token: string | null,
  handle: string,
  repoName: string,
  path: string,
  sha: string,
): Promise<FileDiffMeta> {
  const key = `${handle}/${repoName}|${sha}|${path}`;
  let p = metaCache.get(key);
  if (!p) {
    p = getFileDiffMeta(token, handle, repoName, path, sha);
    p.catch(() => metaCache.delete(key));
    metaCache.set(key, p);
  }
  return p;
}

/**
 * Compute-tier metadata for a file at a commit (cached; no diff is computed
 * server-side). Null while loading — and stays null on failure, which reads as
 * "capability unknown": the pill still renders, Tier B just stays disabled.
 * Pass `enabled: false` from callsites that render non-semantic files too, so
 * only files with a semantic gate ever ask.
 */
export function useFileDiffMeta(
  token: string | null,
  repoBase: string,
  path: string,
  sha: string,
  enabled = true,
): FileDiffMeta | null {
  const [meta, setMeta] = useState<FileDiffMeta | null>(null);
  // repoBase is "/handle/repo"
  const [, handle, repoName] = repoBase.split("/");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchMetaOnce(token, handle, repoName, path, sha)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {
        /* capability unknown — Tier B stays unoffered */
      });
    return () => {
      cancelled = true;
    };
  }, [token, handle, repoName, path, sha, enabled]);
  return meta;
}

// ─── the mode pill (diff header) ────────────────────────────────────────────────

const TIER_DESCRIPTIONS: Record<ComputeTier, string> = {
  server: "Canonical — the diff of record, computed and cached by ForgeHub",
  browser: "Runs the official handler's wasm build in this tab",
  local: "Your own forge renders it — nothing downloads from ForgeHub",
};

/**
 * Quiet compute-tier indicator + switcher for a semantic file's diff header
 * ("rendered on server · switch"). Tier B is capability-detected: it is
 * disabled with the reason (and its honest download cost shown) straight from
 * the shared meta; while meta is unknown it stays disabled rather than
 * over-promising.
 */
export function ComputeTierPill({
  tier,
  onChange,
  meta,
}: {
  tier: ComputeTier;
  onChange: (t: ComputeTier, opts?: { allFormats?: boolean }) => void;
  meta: FileDiffMeta | null;
}) {
  const assessment: TierBAssessment = meta
    ? assessBrowserTier(meta)
    : { available: false, reason: "checking capability…" };
  const mismatch = meta ? buildMismatch(meta) : null;

  return (
    // The header row toggles expansion on click — the pill must not.
    <span onClick={(e) => e.stopPropagation()} className="contents">
      <DropdownMenu
        width={300}
        trigger={
          <button
            type="button"
            aria-label={`Rendered on ${TIER_LABELS[tier].label} — switch compute tier`}
            className={cx(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-fh-xs leading-none",
              "cursor-pointer transition-colors",
              mismatch && tier !== "server"
                ? "border-fh-warning-fg/40 bg-fh-warning-muted text-fh-warning-fg"
                : "border-fh-border bg-fh-surface text-fh-fg-muted hover:border-fh-border-strong hover:text-fh-fg",
            )}
          >
            <span className="font-semibold">Tier {TIER_LABELS[tier].tier}</span>
            <span className="opacity-80">· {TIER_LABELS[tier].label}</span>
          </button>
        }
      >
        <DropdownLabel>Compute diff on</DropdownLabel>
        <TierItem tier="server" current={tier} onChange={onChange} detail="canonical" />
        <TierItem
          tier="browser"
          current={tier}
          onChange={onChange}
          disabled={!assessment.available}
          detail={assessment.available ? browserDownloadLabel(meta!) : assessment.reason}
        />
        <TierItem tier="local" current={tier} onChange={onChange} detail="forge diff --web" />
        <DropdownSeparator />
        <DropdownItem onSelect={() => onChange(tier, { allFormats: true })}>
          Use Tier {TIER_LABELS[tier].tier} for all formats
        </DropdownItem>
      </DropdownMenu>
    </span>
  );
}

function TierItem({
  tier,
  current,
  onChange,
  disabled,
  detail,
}: {
  tier: ComputeTier;
  current: ComputeTier;
  onChange: (t: ComputeTier) => void;
  disabled?: boolean;
  detail?: string;
}) {
  return (
    <DropdownItem
      onSelect={() => onChange(tier)}
      disabled={disabled}
      trailing={current === tier ? <CheckMark /> : undefined}
    >
      <span title={TIER_DESCRIPTIONS[tier]}>
        <span className="font-semibold">Tier {TIER_LABELS[tier].tier}</span> — {TIER_LABELS[tier].label}
        {detail && <span className="block text-fh-xs text-fh-fg-subtle">{detail}</span>}
      </span>
    </DropdownItem>
  );
}

// ─── build-mismatch banner (loud, shared by Tiers B and L) ──────────────────────

/**
 * Shown whenever a client tier would execute (or forge would execute) a build
 * other than the one the repo pins in .forge/handlers. Never silent
 * (SPEC-RENDERING §4): the diff may legitimately differ from what `forge`
 * produced at the pinned build, and the viewer must know before trusting it.
 */
export function BuildMismatchBanner({ meta }: { meta: FileDiffMeta }) {
  const mismatch = buildMismatch(meta);
  if (!mismatch) return null;
  return (
    <div
      role="alert"
      className="mb-3 rounded-md border border-fh-warning-fg/40 bg-fh-warning-muted px-3 py-2 text-fh-sm text-fh-warning-fg"
    >
      <strong className="font-semibold">Handler build mismatch.</strong> This repo pins{" "}
      <code className="font-mono">{meta.handlerId}@{mismatch.pinned}</code> in{" "}
      <code className="font-mono">.forge/handlers</code>, but the available build is{" "}
      <code className="font-mono">{mismatch.official}</code>. The diff below may differ from what the
      pinned build would produce.
    </div>
  );
}

// ─── Tier B: honest-cost gate ───────────────────────────────────────────────────

/**
 * Consent screen before any browser compute happens: says exactly what will be
 * downloaded (both blobs + the wasm build) and does nothing until clicked.
 * Costs are never discovered mid-download (SPEC-RENDERING §5, honest costs).
 */
export function BrowserComputeGate({ meta, onCompute }: { meta: FileDiffMeta; onCompute: () => void }) {
  return (
    <div className="px-4 py-3">
      <BuildMismatchBanner meta={meta} />
      <p className="text-fh-sm text-fh-fg-muted">
        Computing this diff in your browser {browserDownloadLabel(meta)} plus the{" "}
        <code className="font-mono">{meta.handlerId}</code> wasm build.
      </p>
      <button
        type="button"
        onClick={onCompute}
        className={cx(
          "mt-2 inline-flex items-center rounded-md border border-fh-border bg-fh-surface-muted px-3 py-1.5",
          "text-fh-sm font-medium text-fh-fg cursor-pointer transition-colors hover:border-fh-border-strong",
        )}
      >
        Compute in browser
      </button>
    </div>
  );
}

// ─── Tier L: forge hand-off ─────────────────────────────────────────────────────

/**
 * The "Open in forge" hand-off: a copyable `forge diff --web` command (the
 * flag ships in forge today; a forge:// deep link is a later nicety). Zero
 * bytes leave ForgeHub — the blobs are already in the user's clone.
 */
export function LocalHandoffPanel({ meta }: { meta: FileDiffMeta }) {
  const command = forgeDiffCommand(meta.path, meta.baseSha, meta.headSha);
  return (
    <div className="px-4 py-3">
      <BuildMismatchBanner meta={meta} />
      <p className="text-fh-sm text-fh-fg-muted">
        Render this diff on your machine — run in your clone (nothing downloads from ForgeHub):
      </p>
      <CopyableCommand command={command} />
    </div>
  );
}

/** A monospace one-liner with a copy-on-click affordance (ShaChip's pattern). */
export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — the text is still selectable */
    }
  }, [command]);

  return (
    <Tooltip label={copied ? "Copied" : "Copy command"}>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy forge command"
        className={cx(
          "mt-2 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left font-mono text-fh-xs",
          "cursor-pointer transition-colors",
          copied
            ? "border-fh-success-fg/40 bg-fh-success-muted text-fh-success-fg"
            : "border-fh-border bg-fh-surface-muted text-fh-fg hover:border-fh-border-strong",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{command}</span>
        <span className="shrink-0 text-fh-fg-subtle">{copied ? "copied" : "copy"}</span>
      </button>
    </Tooltip>
  );
}

// ─── Tier S: reactive slow-server nudge ─────────────────────────────────────────

/**
 * Replaces the plain "computing…" line once the Tier-S request has been in
 * flight past the latency threshold: offers the client tiers instead of
 * leaving the user staring at a spinner (SPEC-RENDERING §5, reactive nudge).
 * The request itself is NOT cancelled — if it lands first, the nudge vanishes.
 */
export function SlowServerNudge({
  meta,
  onSwitch,
}: {
  meta: FileDiffMeta | null;
  onSwitch: (t: ComputeTier) => void;
}) {
  const browserOk = meta !== null && assessBrowserTier(meta).available;
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface-muted px-3 py-2">
      <p className="text-fh-sm text-fh-fg-muted">
        The server is taking longer than usual — render on your machine instead?
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {browserOk && (
          <button type="button" onClick={() => onSwitch("browser")} className={nudgeButtonCls}>
            Compute in browser ({browserDownloadLabel(meta)})
          </button>
        )}
        <button type="button" onClick={() => onSwitch("local")} className={nudgeButtonCls}>
          Open in forge
        </button>
      </div>
    </div>
  );
}

const nudgeButtonCls = cx(
  "inline-flex items-center rounded-md border border-fh-border bg-fh-surface px-2.5 py-1",
  "text-fh-xs font-medium text-fh-fg cursor-pointer transition-colors hover:border-fh-border-strong",
);

function CheckMark() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}
