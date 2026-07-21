import type { User } from "../../types";
import { IssuesListView } from "./issues/IssuesListView";
import { IssueDetailView } from "./issues/IssueDetailView";
import { NewIssueComposer } from "./issues/NewIssueComposer";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  splat: string;
};

/**
 * Issues experience router. `splat` is the sub-path after `/:handle/:repoName/`:
 *   issues            → list
 *   issues/new        → composer
 *   issues/:number    → detail
 */
export function RepoIssuesTab({ token, handle, repoName, user, splat }: Props) {
  if (/^issues\/new\/?$/.test(splat)) {
    return <NewIssueComposer token={token} handle={handle} repoName={repoName} user={user} />;
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
