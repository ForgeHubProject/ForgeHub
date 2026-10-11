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
 * The ref a `tree/<ref>[/<path>]` splat names. Branch names can contain
 * slashes, so the longest branch the splat starts with wins; failing that, a
 * commit hash (7–40 hex) as the first segment (#215). A branch named like a
 * hash is matched as the branch. Anything else is null.
 */
export function refFromSplat(splat: string, branches: BranchInfo[]): string | null {
  if (!splat.startsWith("tree/")) return null;
  const rest = splat.slice(5);
  const sorted = [...branches].sort((a, b) => b.name.length - a.name.length);
  for (const b of sorted) {
    if (rest === b.name || rest.startsWith(b.name + "/")) return b.name;
  }
  const first = rest.split("/")[0] ?? "";
  return /^[0-9a-f]{7,40}$/i.test(first) ? first : null;
}
