import type { DiffChange } from "../types";
import { gltfChangeType } from "../types";

export type DiffSummary = Record<"added" | "removed" | "modified" | "moved", number>;

/**
 * Count a structured diff's changes by derived type (added / removed / modified /
 * moved). "moved" is inferred from transform-only field changes — the same
 * derivation the glTF workspace diff inspector uses (types.gltfChangeType), so the
 * design compare view speaks the identical visual language as PR diffs.
 */
export function summarizeChanges(changes: DiffChange[]): DiffSummary {
  const s: DiffSummary = { added: 0, removed: 0, modified: 0, moved: 0 };
  for (const c of changes) {
    const t = gltfChangeType(c);
    if (t === "added") s.added++;
    else if (t === "removed") s.removed++;
    else if (t === "moved") s.moved++;
    else s.modified++;
  }
  return s;
}
