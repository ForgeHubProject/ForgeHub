import { useRepoPermission } from "../permission";
import type { User } from "../../../types";
import { ProjectsListView } from "./ProjectsListView";
import { ProjectBoardView } from "./ProjectBoardView";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  splat: string;
  /** Bubbled up so RepoPage can refresh the tab's open-project count. */
  onProjectsChanged?: () => void;
};

/**
 * Projects experience router. `splat` is the sub-path after `/:handle/:repoName/`:
 *   projects            → list of projects
 *   projects/:number    → one project's board / table
 */
export function RepoProjectsTab({ token, handle, repoName, user, splat, onProjectsChanged }: Props) {
  const base = `/${handle}/${repoName}`;

  // Write access drives every mutating affordance: the server's verdict for
  // this viewer and repo (#218), so org owners and team writers get it too.
  const { canWrite } = useRepoPermission();

  const detail = splat.match(/^projects\/(\d+)$/);
  if (detail) {
    return (
      <ProjectBoardView
        token={token}
        handle={handle}
        repoName={repoName}
        base={base}
        projectNumber={Number(detail[1])}
        canWrite={canWrite}
        onChanged={onProjectsChanged}
      />
    );
  }

  return (
    <ProjectsListView
      token={token}
      handle={handle}
      repoName={repoName}
      base={base}
      canWrite={canWrite}
      onChanged={onProjectsChanged}
    />
  );
}
