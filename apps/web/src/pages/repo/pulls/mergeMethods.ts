/**
 * Merge-method model shared by the MergeBox split-button/dropdown. Kept as pure
 * data + helpers (no React, no DOM) so it can be unit-tested in the node test
 * env and reused by the component. The last-used method is remembered per repo
 * in localStorage, GitHub-style.
 */
import type { MergeMethod } from "../../../api";

export type { MergeMethod };

export type MergeMethodOption = {
  method: MergeMethod;
  /** Label for the primary action button, e.g. "Squash and merge". */
  buttonLabel: string;
  /** Short menu title. */
  menuLabel: string;
  /** One-line explanation shown in the dropdown. */
  description: string;
};

export const MERGE_METHOD_OPTIONS: readonly MergeMethodOption[] = [
  {
    method: "merge",
    buttonLabel: "Merge pull request",
    menuLabel: "Create a merge commit",
    description: "All commits from the source branch are added to the base branch via a merge commit.",
  },
  {
    method: "squash",
    buttonLabel: "Squash and merge",
    menuLabel: "Squash and merge",
    description: "The commits are combined into one commit on the base branch.",
  },
  {
    method: "rebase",
    buttonLabel: "Rebase and merge",
    menuLabel: "Rebase and merge",
    description: "The commits are rebased and replayed onto the base branch individually.",
  },
] as const;

const VALID_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && (VALID_METHODS as readonly string[]).includes(value);
}

export function mergeMethodOption(method: MergeMethod): MergeMethodOption {
  return MERGE_METHOD_OPTIONS.find((o) => o.method === method) ?? MERGE_METHOD_OPTIONS[0];
}

/** Per-repo localStorage key for the last-used merge method. */
export function mergeMethodStorageKey(handle: string, repoName: string): string {
  return `fh_merge_method:${handle}/${repoName}`;
}

/** Minimal storage surface so this is testable without a real localStorage. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Read the remembered method for a repo, falling back to "merge". */
export function readMergeMethod(handle: string, repoName: string, storage?: StorageLike | null): MergeMethod {
  const store = storage ?? safeLocalStorage();
  if (!store) return "merge";
  try {
    const raw = store.getItem(mergeMethodStorageKey(handle, repoName));
    return isMergeMethod(raw) ? raw : "merge";
  } catch {
    return "merge";
  }
}

/** Remember the method for a repo (best-effort; ignores storage failures). */
export function writeMergeMethod(handle: string, repoName: string, method: MergeMethod, storage?: StorageLike | null): void {
  const store = storage ?? safeLocalStorage();
  if (!store) return;
  try {
    store.setItem(mergeMethodStorageKey(handle, repoName), method);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** The title of the reverting PR ForgeHub opens for a merged PR. */
export function revertPrTitle(originalTitle: string, number: number): string {
  return `Revert "${originalTitle}" (!${number})`;
}

/**
 * True when an error message describes a merge/rebase conflict — used to switch
 * the MergeBox into its conflict-resolution affordance and surface a token-
 * styled note pointing at the conflict flow.
 */
export function isConflictError(message: string): boolean {
  return /conflict|cannot auto-merge|could not be replayed/i.test(message);
}

function safeLocalStorage(): StorageLike | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
    }
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return null;
}
