import type { MergeMethod } from "./git-utils.js";

/**
 * Per-repo merge-method policy (issue #119). The Repo row stores the owner's
 * choices string-encoded (`allowedMergeMethods` = comma-separated set,
 * `defaultMergeMethod` = one method); this module is the single place that
 * parses those columns back into a well-formed policy. Parsing is defensive —
 * an empty/corrupt set falls back to "everything allowed" and a default outside
 * the allowed set snaps to the first allowed method — so a hand-edited database
 * can never brick a repo's merge box.
 */

export const ALL_MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export type MergePolicy = {
  /** Allowed methods in canonical order (merge, squash, rebase); never empty. */
  allowedMethods: MergeMethod[];
  /** The preselected method; always a member of `allowedMethods`. */
  defaultMethod: MergeMethod;
};

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && (ALL_MERGE_METHODS as readonly string[]).includes(value);
}

/** Parse the stored comma-separated set; unknown entries drop, empty ⇒ all. */
export function parseAllowedMethods(raw: string | null | undefined): MergeMethod[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(isMergeMethod);
  // Canonical order + dedupe, so the merge box renders a stable menu.
  const set = new Set(parsed);
  const ordered = ALL_MERGE_METHODS.filter((m) => set.has(m));
  return ordered.length > 0 ? ordered : [...ALL_MERGE_METHODS];
}

/** The repo's effective merge policy, from its (possibly absent) policy columns. */
export function repoMergePolicy(repo: {
  allowedMergeMethods?: string | null;
  defaultMergeMethod?: string | null;
}): MergePolicy {
  const allowedMethods = parseAllowedMethods(repo.allowedMergeMethods);
  const stored = repo.defaultMergeMethod;
  const defaultMethod =
    isMergeMethod(stored) && allowedMethods.includes(stored) ? stored : allowedMethods[0];
  return { allowedMethods, defaultMethod };
}
