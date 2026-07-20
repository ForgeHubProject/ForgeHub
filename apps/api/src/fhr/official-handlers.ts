import { extname } from "node:path";
import type { StructuredDiff } from "../handlers/types.js";
import { instantiateWasmHandler, type WasmHandler } from "./wasm-runtime.js";
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
  const ext = extname(filePath).toLowerCase();
  if (!activeExts.has(ext)) return null;
  if (base.length > MAX_WASM_BYTES || head.length > MAX_WASM_BYTES) return null;

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

  let handler: WasmHandler | null;
  try {
    handler = await loadWasmHandler(handlerId, wasmUrl, deps);
  } catch {
    return null;
  }
  if (!handler) return null;

  try {
    return { diff: await handler.diff(base, head), handlerId };
  } catch {
    // Malformed input the wasm rejects — unavailable, no local fallback (#74).
    return null;
  }
}
