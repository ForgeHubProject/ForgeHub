import type { BranchInfo, User } from "../../types";
import { PullCreate } from "./pulls/PullCreate";
import { PullDetail } from "./pulls/PullDetail";
import { PullsList } from "./pulls/PullsList";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  branches: BranchInfo[];
  defaultBranch: string;
  currentRef: string;
  splat: string;
};

/**
 * Router for the repository's pull-requests experience:
 *   pulls            → list (filter by state, open a new PR)
 *   pulls/new        → compose (compare branches, title/description)
 *   pulls/:number    → detail (conversation, commits, files, merge box)
 *
 * Presentational pieces live in ./pulls/*. This tab restyles the chrome only —
 * the file-diff viewer registry (semantic FHR diffs) and the merge / merge-
 * resolve wiring are consumed as-is.
 */
export function RepoPullsTab({ token, handle, repoName, branches, defaultBranch, currentRef, splat }: Props) {
  const match = splat.match(/^pulls\/(\d+)$/);
  if (match) {
    return <PullDetail token={token} handle={handle} repoName={repoName} number={Number(match[1])} />;
  }
  if (splat === "pulls/new") {
    return (
      <PullCreate
        token={token}
        handle={handle}
        repoName={repoName}
        branches={branches}
        defaultBranch={defaultBranch}
        currentRef={currentRef}
      />
    );
  }
  return <PullsList token={token} handle={handle} repoName={repoName} />;
}
