import type { FileDiffMeta } from "../api";

// Compute-tier selection logic for semantic diffs (issue #66 P4,
// SPEC-RENDERING §4–§5). Pure and storage-injectable so tier decisions are
// unit-testable without a DOM. The invariants live here, the chrome in
// computeTierUi.tsx:
//
//   S — Server (default). Canonical; the record for review. Unchanged path.
//   B — Browser. The official handler's wasm build runs in the viewer's
//       browser; downloads both blobs. Viewing convenience only.
//   L — Local. The user's own forge via `forge diff --web`; zero download
//       when the repo is already cloned.

export type ComputeTier = "server" | "browser" | "local";

export const COMPUTE_TIERS: readonly ComputeTier[] = ["server", "browser", "local"];

/** Short pill labels ("Tier S · server" reads as label + description). */
export const TIER_LABELS: Record<ComputeTier, { tier: string; label: string }> = {
  server: { tier: "S", label: "server" },
  browser: { tier: "B", label: "browser" },
  local: { tier: "L", label: "local" },
};

export function isComputeTier(v: unknown): v is ComputeTier {
  return v === "server" || v === "browser" || v === "local";
}

// ─── capability detection (Tier B) ──────────────────────────────────────────────

/**
 * Ceiling on the combined blob download before Tier B is withheld entirely
 * (SPEC-RENDERING open question 3's proposal: hide above 200 MB combined).
 */
export const TIER_B_MAX_COMBINED_BYTES = 200 * 1024 * 1024;

/** Tier-S latency past which the reactive "render on your machine?" nudge shows. */
export const TIER_S_SLOW_MS = 4000;

/** WebAssembly support probe, parameterized for tests via `scope`. */
export function browserWasmSupported(scope: object = globalThis): boolean {
  const wasm = (scope as { WebAssembly?: { instantiate?: unknown } }).WebAssembly;
  return typeof wasm === "object" && wasm !== null && typeof wasm.instantiate === "function";
}

export type TierBAssessment =
  | { available: true; downloadBytes: number }
  | { available: false; reason: string };

/**
 * Whether Tier B can be offered for this file, and at what honest cost.
 * Capability is detected, never assumed (SPEC-RENDERING §4): the manifest must
 * declare a wasm build, the browser must run wasm, and the combined blob
 * download must be under the ceiling. When unavailable the UI hides/disables
 * the option and shows the reason — it never fails later instead.
 */
export function assessBrowserTier(
  meta: FileDiffMeta,
  wasmSupported: boolean = browserWasmSupported(),
): TierBAssessment {
  if (!wasmSupported) {
    return { available: false, reason: "this browser does not support WebAssembly" };
  }
  if (!meta.wasmAvailable) {
    return { available: false, reason: `handler '${meta.handlerId}' publishes no wasm build` };
  }
  const downloadBytes = (meta.baseSize ?? 0) + (meta.headSize ?? 0);
  if (downloadBytes > TIER_B_MAX_COMBINED_BYTES) {
    return {
      available: false,
      reason: `blobs are too large to compute in the browser (${formatBytes(downloadBytes)} combined)`,
    };
  }
  return { available: true, downloadBytes };
}

/** "84 MB", "1.2 GB" — for honest download-cost disclosure. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${round1(n / (1024 * 1024))} MB`;
  return `${round1(n / (1024 * 1024 * 1024))} GB`;
}

function round1(x: number): string {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * The honest Tier-B cost line, e.g. "downloads 2 × 84 MB" when the blobs are
 * the same size, "downloads 84 MB + 91 MB" otherwise, "downloads 84 MB" when
 * only one blob exists (added/deleted file).
 */
export function browserDownloadLabel(meta: FileDiffMeta): string {
  const sizes = [meta.baseSize, meta.headSize].filter((s): s is number => s !== null);
  if (sizes.length === 0) return "downloads nothing";
  if (sizes.length === 2 && formatBytes(sizes[0]) === formatBytes(sizes[1])) {
    return `downloads 2 × ${formatBytes(sizes[0])}`;
  }
  return `downloads ${sizes.map(formatBytes).join(" + ")}`;
}

// ─── build pinning (Tiers B/L consistency) ──────────────────────────────────────

export type BuildMismatch = { pinned: string; official: string };

/**
 * Non-null when the repo's `.forge/handlers` lockfile pins a build that differs
 * from the one the manifest currently serves (which is what both the server and
 * the /handlers wasm proxy execute). The UI must surface this loudly — a diff
 * computed by a different build than the repo pinned must never render
 * silently (SPEC-RENDERING §4 invariants). An unpinned repo never mismatches.
 */
export function buildMismatch(meta: FileDiffMeta): BuildMismatch | null {
  if (meta.pinnedBuild === null || meta.officialBuild === null) return null;
  if (meta.pinnedBuild === meta.officialBuild) return null;
  return { pinned: meta.pinnedBuild, official: meta.officialBuild };
}

// ─── Tier L hand-off ────────────────────────────────────────────────────────────

/**
 * The copyable `forge diff --web` command for Tier L (SPEC-RENDERING §5; the
 * flag shipped in forge P2). SHAs are abbreviated for paste-friendliness; git
 * resolves any unambiguous prefix. With no base (added file / root commit) the
 * range is dropped and forge diffs against the working tree.
 */
export function forgeDiffCommand(path: string, baseSha: string | null, headSha: string): string {
  // Quote the path only when it needs it, so the common case stays clean.
  const p = /[\s"'\\$`]/.test(path) ? `"${path.replace(/(["\\$`])/g, "\\$1")}"` : path;
  if (!baseSha) return `forge diff --web ${p}`;
  return `forge diff --web ${p} ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`;
}

// ─── sticky preference (per-format + global) ────────────────────────────────────

// localStorage keys. Per-format keys are suffixed with the registry's routing
// key (lowercase extension, no dot — see extensionForFilename).
const GLOBAL_KEY = "fh.computeTier";
const formatKey = (ext: string) => `fh.computeTier.${ext.toLowerCase()}`;

/** The subset of Storage the preference store needs; injectable for tests. */
export type TierStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): TierStorage | null {
  // localStorage can throw on access (privacy modes); preferences then simply
  // don't stick, they never break the page.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readTier(key: string, storage: TierStorage | null): ComputeTier | null {
  try {
    const v = storage?.getItem(key);
    return isComputeTier(v) ? v : null;
  } catch {
    return null;
  }
}

/** The sticky per-format tier choice, or null if the user never chose one. */
export function getTierPreference(ext: string, storage: TierStorage | null = defaultStorage()): ComputeTier | null {
  return readTier(formatKey(ext), storage);
}

export function setTierPreference(ext: string, tier: ComputeTier, storage: TierStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(formatKey(ext), tier);
  } catch {
    /* preference doesn't stick — non-fatal */
  }
}

export function clearTierPreference(ext: string, storage: TierStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(formatKey(ext));
  } catch {
    /* non-fatal */
  }
}

/** The global default tier (the settings-page choice), or null if unset. */
export function getGlobalTierPreference(storage: TierStorage | null = defaultStorage()): ComputeTier | null {
  return readTier(GLOBAL_KEY, storage);
}

export function setGlobalTierPreference(tier: ComputeTier | null, storage: TierStorage | null = defaultStorage()): void {
  try {
    if (tier === null) storage?.removeItem(GLOBAL_KEY);
    else storage?.setItem(GLOBAL_KEY, tier);
  } catch {
    /* non-fatal */
  }
}

/**
 * The tier a file of this format starts in: the sticky per-format choice wins,
 * then the global setting, then Tier S — the canonical default. Server compute
 * stays the record for review either way; client tiers are viewing convenience.
 */
export function resolveTierPreference(ext: string, storage: TierStorage | null = defaultStorage()): ComputeTier {
  return getTierPreference(ext, storage) ?? getGlobalTierPreference(storage) ?? "server";
}

/** Enumerable Storage surface, for listing per-format overrides in settings. */
export type EnumerableTierStorage = TierStorage & Pick<Storage, "length" | "key">;

function defaultEnumerableStorage(): EnumerableTierStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Every sticky per-format choice, for the settings page. Sorted by extension. */
export function listTierPreferences(
  storage: EnumerableTierStorage | null = defaultEnumerableStorage(),
): Array<{ ext: string; tier: ComputeTier }> {
  const prefix = `${GLOBAL_KEY}.`;
  const out: Array<{ ext: string; tier: ComputeTier }> = [];
  try {
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage!.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const tier = readTier(key, storage);
      if (tier) out.push({ ext: key.slice(prefix.length), tier });
    }
  } catch {
    /* unenumerable storage — nothing to list */
  }
  return out.sort((a, b) => a.ext.localeCompare(b.ext));
}
