import { handlerWasmFhr1Url, handlerWasmUrl } from "./manifest.js";
import type { WasmAbi } from "./wasm-runtime.js";

// Which wasm build of an official handler ForgeHub runs. A handler can ship
// two (FHR SPEC §7):
//   * the fhr-wasm-1 module, the contract any language implements — preferred;
//   * the older Go-only GOOS=js build — the fallback.
// The fallback covers the window after FHR publishes a manifest entry and
// before the release has uploaded the module, and a module that will not
// start. Both the server's own runner (official-handlers.ts) and the browser's
// copy (routes/handler-wasm.ts) choose through here, so they always agree.
//
// FHR_WASM_BASE is the self-hosting override: both URLs follow the release
// layout under it. FHR_WASM_ABI=go-js is an operator's escape hatch that keeps
// every handler on its Go build.

export type WasmCandidate = { abi: WasmAbi; url: string };

/** A handler's wasm builds, most preferred first; empty when it has none. */
export async function wasmCandidates(handlerId: string): Promise<WasmCandidate[]> {
  const goOnly = process.env["FHR_WASM_ABI"] === "go-js";
  const base = process.env["FHR_WASM_BASE"];
  const candidates: WasmCandidate[] = [];
  if (base) {
    if (!goOnly) candidates.push({ abi: "fhr-wasm-1", url: `${base}/forge-handler-${handlerId}.fhr1.wasm` });
    candidates.push({ abi: "go-js", url: `${base}/forge-handler-${handlerId}.wasm` });
    return candidates;
  }
  const [fhr1, goJs] = await Promise.all([handlerWasmFhr1Url(handlerId), handlerWasmUrl(handlerId)]);
  if (fhr1 && !goOnly) candidates.push({ abi: "fhr-wasm-1", url: fhr1 });
  if (goJs) candidates.push({ abi: "go-js", url: goJs });
  return candidates;
}

/** Download one candidate; null when it isn't there (or the fetch fails). */
export async function fetchCandidate(candidate: WasmCandidate, fetchImpl: typeof fetch): Promise<Buffer | null> {
  try {
    const res = await fetchImpl(candidate.url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
