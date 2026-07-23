import { useEffect, useState } from "react";
import { listRepoMembers } from "../../../api";
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

  // Write access drives every mutating affordance. Owner is known from the route
  // handle; a WRITER collaborator is discovered from the members list.
  const [canWrite, setCanWrite] = useState(user.handle === handle);
  useEffect(() => {
    let cancelled = false;
    listRepoMembers(token, handle, repoName)
      .then(({ members }) => {
        if (cancelled) return;
        const me = members.find((m) => m.handle === user.handle);
        setCanWrite(me?.role === "owner" || me?.role === "writer");
      })
      .catch(() => { if (!cancelled) setCanWrite(user.handle === handle); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, user.handle]);

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
