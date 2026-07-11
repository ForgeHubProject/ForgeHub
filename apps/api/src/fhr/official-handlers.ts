import { extname } from "node:path";
import type { StructuredDiff } from "../handlers/types.js";
import { instantiateWasmHandler, type WasmHandler } from "./wasm-runtime.js";

// Official FHR format → handler map. Mirrors the fhr-official manifest's
// [formats] table. This is deliberately explicit: the server resolves handlers
// ONLY from this official set and never consults a repo's `.forge/handlers`
// source URLs or a machine's `~/.forge/sources.list`. Running a community
// handler that a repo points at would be executing untrusted code on the
// server on behalf of every viewer — so ForgeHub is "forge as a client," but
// pinned to the official registry.
const OFFICIAL_FORMATS: Record<string, string> = {
  ".gltf": "gltf-scene",
  ".glb": "gltf-scene",
};

// Base URL for official wasm assets (the rolling release the renderer proxy
// also pulls from). Overridable for self-hosting / tests.
const WASM_BASE =
  process.env["FHR_WASM_BASE"] ??
  "https://github.com/forgehubproject/fhr/releases/download/gltf-scene-latest";

// Never run wasm on very large blobs: a synchronous wasm call can't be
// interrupted from JS, so an oversized/crafted input is a DoS risk. Above this
// the caller falls back to the built-in TS handler.
const MAX_WASM_BYTES = 8 * 1024 * 1024;

export function officialHandlerId(ext: string): string | null {
  return OFFICIAL_FORMATS[ext.toLowerCase()] ?? null;
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

function loadWasmHandler(handlerId: string, deps: OfficialHandlerDeps): Promise<WasmHandler | null> {
  let p = instanceCache.get(handlerId);
  if (!p) {
    p = (async () => {
      const res = await deps.fetchImpl(`${WASM_BASE}/forge-handler-${handlerId}.wasm`);
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
 * Compute a diff for a file using the official wasm handler, or return null to
 * let the caller fall back to the built-in TS handler. Scoped to the repo's
 * opted-in extensions exactly like the TS path.
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
  const handlerId = officialHandlerId(ext);
  if (!handlerId) return null;
  if (base.length > MAX_WASM_BYTES || head.length > MAX_WASM_BYTES) return null;

  let handler: WasmHandler | null;
  try {
    handler = await loadWasmHandler(handlerId, deps);
  } catch {
    return null;
  }
  if (!handler) return null;

  try {
    return { diff: await handler.diff(base, head), handlerId };
  } catch {
    // Malformed input the wasm rejects — fall back to the built-in handler.
    return null;
  }
}
