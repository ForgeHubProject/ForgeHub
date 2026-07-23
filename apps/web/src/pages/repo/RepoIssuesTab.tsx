import type { User } from "../../types";
import { IssuesListView } from "./issues/IssuesListView";
import { IssueDetailView } from "./issues/IssueDetailView";
import { NewIssueComposer } from "./issues/NewIssueComposer";
import { MilestonesListView } from "./issues/MilestonesListView";
import { MilestoneDetailView } from "./issues/MilestoneDetailView";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  splat: string;
};

/**
 * Issues experience router. `splat` is the sub-path after `/:handle/:repoName/`:
 *   issues                    → list
 *   issues/new                → composer
 *   issues/milestones         → milestones list (#83)
 *   issues/milestones/:number → milestone detail (#83)
 *   issues/:number            → detail
 *
 * Milestones live under the issues surface (RepoPage routes any `issues*` path
 * here), so they share the Issues tab without touching the repo shell.
 */
export function RepoIssuesTab({ token, handle, repoName, user, splat }: Props) {
  if (/^issues\/new\/?$/.test(splat)) {
    return <NewIssueComposer token={token} handle={handle} repoName={repoName} user={user} />;
  }

  const milestoneDetail = splat.match(/^issues\/milestones\/(\d+)$/);
  if (milestoneDetail) {
    return (
      <MilestoneDetailView token={token} handle={handle} repoName={repoName} number={Number(milestoneDetail[1])} />
    );
  }

  if (/^issues\/milestones\/?$/.test(splat)) {
    return <MilestonesListView token={token} handle={handle} repoName={repoName} user={user} />;
  }

  const detail = splat.match(/^issues\/(\d+)$/);
  if (detail) {
    return (
      <IssueDetailView
        token={token}
        handle={handle}
        repoName={repoName}
        user={user}
        number={Number(detail[1])}
      />
    );
  }

  return <IssuesListView token={token} handle={handle} repoName={repoName} />;
}
