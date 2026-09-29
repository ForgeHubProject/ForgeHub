import { extname } from "node:path";
import type { StructuredDiff } from "../handlers/types.js";
import { instantiateWasmHandler, type WasmConflict, type WasmHandler } from "./wasm-runtime.js";
import { handlerWasmUrl, officialFormats } from "./manifest.js";

// Official FHR format→handler resolution. The manifest (manifest.ts) is the
// single source of truth: this module holds NO hardcoded extension or handler
// knowledge. The server runs a handler ONLY when the manifest maps the file's
// extension to it — it never consults a repo's `.forge/handlers` source URLs or
// a machine's `~/.forge/sources.list`. Running a community handler a repo
// points at would be executing untrusted code on the server on behalf of every
// viewer — so ForgeHub is "forge as a client," pinned to the official registry.

// Never run wasm on very large blobs: a synchronous wasm call can't be
// interrupted from JS, so an oversized/crafted input is a DoS risk. Above this
// the caller returns null (→ 503) rather than running the handler.
const MAX_WASM_BYTES = 8 * 1024 * 1024;

/** The official handler id for an extension, or null. Manifest-driven. */
export async function officialHandlerId(ext: string): Promise<string | null> {
  return (await officialFormats()).get(ext.toLowerCase()) ?? null;
}

/**
 * Resolve where a handler's wasm build lives. Normally the manifest is the
 * authority; FHR_WASM_BASE is an explicit self-hosting override that, when set,
 * derives the URL by the fixed `forge-handler-<id>.wasm` release convention.
 */
async function resolveWasmUrl(handlerId: string): Promise<string | null> {
  const base = process.env["FHR_WASM_BASE"];
  if (base) return `${base}/forge-handler-${handlerId}.wasm`;
  return handlerWasmUrl(handlerId);
}

export type OfficialHandlerDeps = {
  instantiate: typeof instantiateWasmHandler;
  fetchImpl: typeof fetch;
};

const defaultDeps: OfficialHandlerDeps = {
  instantiate: instantiateWasmHandler,
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
};

const instanceCache = new Map<string, Promise<WasmHandler | null>>();

/** Test hook: drop memoized handler instances. */
export function __resetOfficialHandlers(): void {
  instanceCache.clear();
}

/**
 * Test hook: stand a handler in for the official build of `handlerId`, so the
 * merge path can be exercised without fetching a wasm release. The manifest
 * must still map an extension to the id (and give it a wasm URL).
 */
export function __setOfficialHandlerForTests(handlerId: string, handler: WasmHandler): void {
  instanceCache.set(handlerId, Promise.resolve(handler));
}

function loadWasmHandler(
  handlerId: string,
  wasmUrl: string,
  deps: OfficialHandlerDeps,
): Promise<WasmHandler | null> {
  let p = instanceCache.get(handlerId);
  if (!p) {
    p = (async () => {
      const res = await deps.fetchImpl(wasmUrl);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return deps.instantiate(bytes, handlerId);
    })();
    instanceCache.set(handlerId, p);
    // Don't memoize failures — allow a later retry after a transient error.
    p.then((h) => { if (!h) instanceCache.delete(handlerId); }).catch(() => instanceCache.delete(handlerId));
  }
  return p;
}

export type OfficialDiffResult = { diff: StructuredDiff; handlerId: string };

/**
 * Resolve and load the official wasm handler for a file, or null when none can
 * run: not official, not opted in, the manifest or the wasm build unreachable,
 * or the build refusing to start.
 */
async function officialHandlerFor(
  filePath: string,
  activeExts: Set<string>,
  deps: OfficialHandlerDeps,
): Promise<{ handlerId: string; handler: WasmHandler } | null> {
  const ext = extname(filePath).toLowerCase();
  if (!activeExts.has(ext)) return null;

  let handlerId: string | null;
  let wasmUrl: string | null;
  try {
    handlerId = await officialHandlerId(ext);
    if (!handlerId) return null;
    wasmUrl = await resolveWasmUrl(handlerId);
  } catch {
    // Manifest unreachable with no cached copy — treat as unavailable.
    return null;
  }
  if (!wasmUrl) return null;

  try {
    const handler = await loadWasmHandler(handlerId, wasmUrl, deps);
    return handler ? { handlerId, handler } : null;
  } catch {
    return null;
  }
}

/**
 * Compute a diff for a file using the official wasm handler the manifest maps
 * its extension to, or return null when no official handler can run it (not
 * opted in, not official, oversized, or the wasm build is unreachable/rejects).
 * The caller treats null as "unavailable" (503) — there is no built-in fallback
 * on this path (#74). Scoped to the repo's opted-in extensions.
 */
export async function officialWasmDiff(
  filePath: string,
  activeExts: Set<string>,
  base: Buffer,
  head: Buffer,
  deps: OfficialHandlerDeps = defaultDeps,
): Promise<OfficialDiffResult | null> {
  if (base.length > MAX_WASM_BYTES || head.length > MAX_WASM_BYTES) return null;
  const official = await officialHandlerFor(filePath, activeExts, deps);
  if (!official) return null;

  try {
    return { diff: await official.handler.diff(base, head), handlerId: official.handlerId };
  } catch {
    // Malformed input the wasm rejects — unavailable, no local fallback (#74).
    return null;
  }
}

// ── merge ─────────────────────────────────────────────────────────────────────
//
// FHR owns what a format's merge is, the same way it owns its diff: a PR merge
// on the server runs the official handler's merge — the build forge runs
// locally as a git merge driver — not a ForgeHub reimplementation (#74).

/**
 * The opted-in extensions whose official handler declares a semantic merge —
 * the files a PR merge must never hand to git's line merge. Loads each
 * handler (once per process) to read its declaration.
 */
export async function officialMergingExtensions(
  activeExts: Set<string>,
  deps: OfficialHandlerDeps = defaultDeps,
): Promise<string[]> {
  const out: string[] = [];
  for (const ext of activeExts) {
    const official = await officialHandlerFor(`file${ext}`, activeExts, deps);
    if (official?.handler.semanticMerge && official.handler.merge) out.push(ext);
  }
  return out.sort();
}

export type OfficialMergeResult =
  | { kind: "merged"; blob: Buffer; conflicts: WasmConflict[]; handlerId: string }
  /** No official handler that merges this file, a side over the wasm cap, or
   *  the handler failed (malformed input, refusal). The file stays conflicted. */
  | { kind: "unavailable"; reason: string };

/** Three-way merge of one file by its official handler. */
export async function officialWasmMerge(
  filePath: string,
  activeExts: Set<string>,
  base: Buffer,
  ours: Buffer,
  theirs: Buffer,
  deps: OfficialHandlerDeps = defaultDeps,
): Promise<OfficialMergeResult> {
  if ([base, ours, theirs].some((b) => b.length > MAX_WASM_BYTES)) {
    return { kind: "unavailable", reason: `a side is over the ${MAX_WASM_BYTES}-byte handler limit` };
  }
  const official = await officialHandlerFor(filePath, activeExts, deps);
  if (!official?.handler.semanticMerge || !official.handler.merge) {
    return { kind: "unavailable", reason: "no official handler that merges this format" };
  }
  try {
    const { blob, conflicts } = await official.handler.merge(base, ours, theirs);
    return { kind: "merged", blob, conflicts, handlerId: official.handlerId };
  } catch (e) {
    return { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}
