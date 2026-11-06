import type { BranchInfo } from "../../types";

/** A full 40-character commit hash — what a commit page's "Browse files" puts in the URL. */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** How a ref reads in the branch picker: a commit hash short, as GitHub's does. */
export function refLabel(ref: string): string {
  return isCommitSha(ref) ? ref.slice(0, 7) : ref;
}

/**
 * The ref a `tree/<ref>[/<path>]` or `blob/<ref>/<path>` splat names. Branch
 * names can contain slashes, so the longest branch the splat starts with wins;
 * failing that, a commit hash (7–40 hex) as the first segment (#215). A branch
 * named like a hash is matched as the branch. Anything else is null.
 */
export function refFromSplat(splat: string, branches: BranchInfo[]): string | null {
  const mode = /^(tree|blob|edit|new|upload|delete)\//.exec(splat);
  if (!mode) return null;
  const rest = splat.slice(mode[0].length);
  const sorted = [...branches].sort((a, b) => b.name.length - a.name.length);
  for (const b of sorted) {
    if (rest === b.name || rest.startsWith(b.name + "/")) return b.name;
  }
  const first = rest.split("/")[0] ?? "";
  return /^[0-9a-f]{7,40}$/i.test(first) ? first : null;
}

/**
 * The ref and file path a `blob/<ref>/<path>` splat names, split where
 * refFromSplat says the ref ends. A ref it does not know (a tag, say) is taken
 * to be the first segment, so the server gets to decide. Null without a path.
 */
export function blobFromSplat(splat: string, branches: BranchInfo[]): { ref: string; path: string } | null {
  if (!splat.startsWith("blob/")) return null;
  const rest = splat.slice(5);
  const ref = refFromSplat(splat, branches) ?? rest.split("/")[0] ?? "";
  const path = rest.slice(ref.length + 1);
  return ref && path ? { ref, path } : null;
}

/** The web-editing pages (#254): edit or delete a file, add one, or upload to a folder. */
export type EditMode = "edit" | "new" | "upload" | "delete";

/**
 * `edit/<branch>/<file>`, `delete/<branch>/<file>`, `new/<branch>[/<folder>]`,
 * `upload/<branch>[/<folder>]`: the mode, the branch, and the file or folder.
 * Only a branch can be edited, so the ref must be one of `branches`.
 */
export function editRouteFromSplat(splat: string, branches: BranchInfo[]): { mode: EditMode; ref: string; path: string } | null {
  const m = /^(edit|new|upload|delete)\//.exec(splat);
  if (!m) return null;
  const ref = refFromSplat(splat, branches);
  if (!ref || !branches.some((b) => b.name === ref)) return null;
  const path = splat.slice(m[0].length + ref.length + 1);
  const mode = m[1] as EditMode;
  if ((mode === "edit" || mode === "delete") && !path) return null;
  return { mode, ref, path };
}
