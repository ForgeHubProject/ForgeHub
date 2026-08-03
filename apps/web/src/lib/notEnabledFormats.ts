import { useEffect, useState } from "react";
import type { FormatNotEnabled } from "../api";

/**
 * Per-view aggregation of /filediff "format-not-enabled" answers (issue #73).
 *
 * Each file's diff viewer fetches its own /filediff, so a commit or PR touching
 * a .glb AND a .step would otherwise show two disconnected "not enabled" cards
 * that each pretend to be alone. Viewers register the payload they received
 * under their view's scope key (repo + head ref); every card in that scope then
 * phrases ONE collective message — "Formats .glb, .step are not added…" — and
 * lists the hint commands for all of them.
 *
 * A module-level store (not React context) keeps this mechanical: sibling
 * viewers aggregate without threading a provider through every page that hosts
 * file diffs. Entries are ref-counted per extension so unmounting one of two
 * .glb cards doesn't drop the extension for the other.
 */

export type NotEnabledEntry = { ext: string; hint: string[] };

const scopes = new Map<string, Map<string, { count: number; entry: NotEnabledEntry }>>();
const listeners = new Map<string, Set<() => void>>();

/** Scope key for one commit/PR file view: same repo + same head ref aggregate. */
export function notEnabledScopeKey(repoBase: string, headRef: string): string {
  return `${repoBase}@${headRef}`;
}

function notify(scope: string): void {
  for (const fn of listeners.get(scope) ?? []) fn();
}

/**
 * Register a not-enabled payload under a scope. Returns the unregister
 * function (for effect cleanup). Ref-counted per extension.
 */
export function registerNotEnabledFormat(scope: string, payload: FormatNotEnabled): () => void {
  let exts = scopes.get(scope);
  if (!exts) {
    exts = new Map();
    scopes.set(scope, exts);
  }
  const ext = payload.ext.toLowerCase();
  const existing = exts.get(ext);
  if (existing) {
    existing.count += 1;
  } else {
    exts.set(ext, { count: 1, entry: { ext, hint: payload.hint } });
    notify(scope);
  }
  let done = false;
  return () => {
    if (done) return; // idempotent — effect cleanup may not run twice, but cheap to guard
    done = true;
    const current = scopes.get(scope)?.get(ext);
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) {
      scopes.get(scope)!.delete(ext);
      if (scopes.get(scope)!.size === 0) scopes.delete(scope);
      notify(scope);
    }
  };
}

/** All not-enabled formats currently known in a scope, sorted by extension. */
export function notEnabledFormatsInScope(scope: string): NotEnabledEntry[] {
  const exts = scopes.get(scope);
  if (!exts) return [];
  return [...exts.values()].map((v) => v.entry).sort((a, b) => a.ext.localeCompare(b.ext));
}

/**
 * The collective message for a set of not-enabled extensions, per the phrasing
 * in #73: singular for one format, a joined list for several.
 */
export function notEnabledMessage(exts: string[]): string {
  const list = exts.join(", ");
  return exts.length > 1
    ? `Formats ${list} are not added to this repo's .forge/formats.`
    : `Format ${list} is not added to this repo's .forge/formats.`;
}

/**
 * React hook: register this viewer's payload in the scope and observe the
 * scope's aggregate. Returns every not-enabled format known in the view so the
 * rendered card can speak for all of them at once.
 */
export function useNotEnabledFormats(scope: string, payload: FormatNotEnabled): NotEnabledEntry[] {
  const [entries, setEntries] = useState<NotEnabledEntry[]>(() => notEnabledFormatsInScope(scope));
  useEffect(() => {
    const unregister = registerNotEnabledFormat(scope, payload);
    const onChange = () => setEntries(notEnabledFormatsInScope(scope));
    let subs = listeners.get(scope);
    if (!subs) {
      subs = new Set();
      listeners.set(scope, subs);
    }
    subs.add(onChange);
    onChange(); // pick up siblings registered before this mount
    return () => {
      subs.delete(onChange);
      if (subs.size === 0) listeners.delete(scope);
      unregister();
    };
  }, [scope, payload]);
  return entries;
}
