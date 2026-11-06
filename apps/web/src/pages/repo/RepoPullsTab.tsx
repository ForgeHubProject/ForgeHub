import type { BranchInfo, User } from "../../types";
import { PullCreate } from "./pulls/PullCreate";
import { PullDetail, type TabKey } from "./pulls/PullDetail";
import { PullsList } from "./pulls/PullsList";

/** `pulls/:number`, or with `/commits`, `/checks` or `/files` for those tabs (#252). */
export const PULL_DETAIL = /^pulls\/(\d+)(?:\/(commits|checks|files))?$/;

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
 *   pulls/:number    → detail, on its Conversation tab
 *   pulls/:number/commits|checks|files → the same, on that tab
 *
 * Presentational pieces live in ./pulls/*. This tab restyles the chrome only —
 * the file-diff viewer registry (semantic FHR diffs) and the merge / merge-
 * resolve wiring are consumed as-is.
 */
export function RepoPullsTab({ token, handle, repoName, user, branches, defaultBranch, currentRef, splat }: Props) {
  const match = splat.match(PULL_DETAIL);
  if (match) {
    // One element for both tabs, so switching keeps what PullDetail has loaded.
    return (
      <PullDetail
        token={token}
        handle={handle}
        repoName={repoName}
        number={Number(match[1])}
        tab={(match[2] as TabKey | undefined) ?? "conversation"}
        user={user}
      />
    );
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
