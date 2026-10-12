import { createContext, useContext } from "react";
import type { Repo } from "../../types";

/**
 * What the signed-in viewer may do in the repository on screen, as the server
 * decided it (`viewerPermission` on the repo payload, #217). Pages ask this
 * instead of comparing the viewer's handle with the URL's: on an org repo the
 * URL handle is the org's, and a write collaborator's never matches (#218).
 */
export type ViewerPermission = NonNullable<Repo["viewerPermission"]> | null;

export type RepoPermission = {
  /** Branches, releases, Actions, projects, milestones, labels, triage: the API's `canWrite`. */
  canWrite: boolean;
  /** Settings, deleting issues and others' comments, marking a PR ready: the API's `canAdmin`. */
  canAdmin: boolean;
};

export function repoPermission(permission: ViewerPermission | undefined): RepoPermission {
  return {
    canWrite: permission === "write" || permission === "admin",
    canAdmin: permission === "admin",
  };
}

const RepoPermissionContext = createContext<ViewerPermission>(null);

/** Set once by RepoPage from the repo payload; every tab under it reads it. */
export const RepoPermissionProvider = RepoPermissionContext.Provider;

/** The viewer's write and admin rights in the current repo. Outside a repo page: none. */
export function useRepoPermission(): RepoPermission {
  return repoPermission(useContext(RepoPermissionContext));
}
