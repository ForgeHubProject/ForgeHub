import type {
  BranchInfo, CommitDetail, CommitInfo, Constraint, DiffResult, FileDiff, Issue, IssueComment,
  Label, Notification, PRFileEntry, PublicProfile, PullRequest, Release, Repo, Snapshot, SnapshotSummary, TagInfo, TreeEntry, User,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const BASE = API_BASE;

async function req<T>(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      ...(rest.body != null ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  return req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function getPublicProfile(token: string | null, handle: string): Promise<PublicProfile> {
  return req(`/users/${handle}`, { token: token ?? undefined });
}

export async function updateMyProfile(
  token: string,
  patch: { displayName?: string; bio?: string; location?: string; website?: string },
): Promise<{ user: User }> {
  return req("/users/me", { method: "PATCH", token, body: JSON.stringify(patch) });
}

export async function getUserRepos(token: string | null, handle: string): Promise<{ repos: Repo[] }> {
  return req(`/users/${handle}/repos`, { token: token ?? undefined });
}

export async function register(
  email: string,
  password: string,
  handle: string,
  displayName?: string,
): Promise<{ token: string; user: User }> {
  return req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, handle, displayName }),
  });
}

export async function getMe(token: string): Promise<User> {
  return req("/auth/me", { token });
}

export async function getMyRepos(token: string): Promise<{ repos: Repo[] }> {
  return req("/repos/mine", { token });
}

export async function getCollaboratingRepos(token: string): Promise<{ repos: Repo[] }> {
  return req("/repos/collaborating", { token });
}

export async function getRepo(
  token: string | null,
  handle: string,
  name: string,
): Promise<Repo> {
  return req(`/repos/${handle}/${name}`, { token: token ?? undefined });
}

export async function createRepo(
  token: string,
  name: string,
  description: string | undefined,
  visibility: "public" | "private",
): Promise<Repo> {
  return req("/repos", {
    method: "POST",
    token,
    body: JSON.stringify({ name, description: description || undefined, visibility }),
  });
}

export async function getSnapshots(
  token: string | null,
  handle: string,
  repoName: string,
  branch?: string,
): Promise<{ snapshots: SnapshotSummary[] }> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : "";
  return req(`/repos/${handle}/${repoName}/snapshots${qs}`, { token: token ?? undefined });
}

export async function getSnapshot(
  token: string | null,
  handle: string,
  repoName: string,
  snapshotId: string,
): Promise<Snapshot> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}`, { token: token ?? undefined });
}

export async function ingestSnapshot(
  token: string,
  handle: string,
  repoName: string,
  gltf: unknown,
  label?: string,
  sourceFile?: string,
  handlerId?: string,
): Promise<Snapshot> {
  return req(`/repos/${handle}/${repoName}/snapshots`, {
    method: "POST",
    token,
    body: JSON.stringify({ gltf, label, sourceFile, ...(handlerId ? { handlerId } : {}) }),
  });
}

export async function createConstraint(
  token: string,
  handle: string,
  repoName: string,
  snapshotId: string,
  entityAId: string,
  entityBId: string,
  positionFixed: boolean,
  rotationFixed: boolean,
): Promise<Constraint> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}/constraints`, {
    method: "POST",
    token,
    body: JSON.stringify({ entityAId, entityBId, positionFixed, rotationFixed }),
  });
}

export async function deleteSnapshot(
  token: string,
  handle: string,
  repoName: string,
  snapshotId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}`, { method: "DELETE", token });
}

export async function deleteEntity(
  token: string,
  handle: string,
  repoName: string,
  snapshotId: string,
  entityId: string,
): Promise<{ snapshotDeleted: boolean; snapshotId?: string; deletedEntities?: number; deletedConstraints?: number }> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}/entities/${entityId}`, {
    method: "DELETE",
    token,
  });
}

export async function compareDiff(
  token: string | null,
  handle: string,
  repoName: string,
  baseId: string,
  targetId: string,
): Promise<DiffResult> {
  return req<DiffResult>(
    `/repos/${handle}/${repoName}/compare?base=${encodeURIComponent(baseId)}&target=${encodeURIComponent(targetId)}`,
    { token: token ?? undefined },
  );
}

export async function deleteConstraint(
  token: string,
  handle: string,
  repoName: string,
  snapshotId: string,
  constraintId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}/constraints/${constraintId}`, {
    method: "DELETE",
    token,
  });
}

export async function moveEntityPosition(
  token: string,
  handle: string,
  repoName: string,
  snapshotId: string,
  entityId: string,
  delta: [number, number, number],
): Promise<{ movedEntityIds: string[]; delta: [number, number, number] }> {
  return req(`/repos/${handle}/${repoName}/snapshots/${snapshotId}/entities/${entityId}/position`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ delta }),
  });
}

// ─── branches ────────────────────────────────────────────────────────────────

export async function listBranches(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ branches: BranchInfo[]; defaultBranch: string }> {
  return req(`/repos/${handle}/${repoName}/branches`, { token: token ?? undefined });
}

export async function createBranch(
  token: string,
  handle: string,
  repoName: string,
  branch: string,
  from?: string,
): Promise<{ branch: string }> {
  return req(`/repos/${handle}/${repoName}/branches`, {
    method: "POST",
    token,
    body: JSON.stringify({ branch, from }),
  });
}

export async function deleteBranch(
  token: string,
  handle: string,
  repoName: string,
  branch: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/branches/${encodeURIComponent(branch)}`, {
    method: "DELETE",
    token,
  });
}

// ─── tags ─────────────────────────────────────────────────────────────────────────────

export async function listTags(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ tags: TagInfo[] }> {
  return req(`/repos/${handle}/${repoName}/tags`, { token: token ?? undefined });
}

// ─── pull requests ────────────────────────────────────────────────────────────────

export async function listPulls(
  token: string | null,
  handle: string,
  repoName: string,
  state?: "open" | "closed" | "merged" | "all",
): Promise<{ pulls: PullRequest[] }> {
  const qs = state ? `?state=${state}` : "";
  return req(`/repos/${handle}/${repoName}/pulls${qs}`, { token: token ?? undefined });
}

export async function createPull(
  token: string,
  handle: string,
  repoName: string,
  title: string,
  fromBranch: string,
  toBranch?: string,
  description?: string,
): Promise<PullRequest> {
  return req(`/repos/${handle}/${repoName}/pulls`, {
    method: "POST",
    token,
    body: JSON.stringify({ title, fromBranch, toBranch, description }),
  });
}

export async function getPull(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<PullRequest> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}`, { token: token ?? undefined });
}

export async function mergePull(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  commitMessage?: string,
): Promise<{ merged: boolean; sha: string }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/merge`, {
    method: "POST",
    token,
    body: JSON.stringify({ commitMessage }),
  });
}

export type MergeSide = "base" | "incoming";

export type TextFileMergeResolution = {
  sourceFile: string;
  hunks: Array<{ hunkId: string; side: MergeSide }>;
};

export type GltfFileMergeResolution = {
  sourceFile: string;
  entities?: Array<{ entityId: string; side: MergeSide }>;
  fields?: Array<{ entityId: string; field: string; side: MergeSide }>;
};

export type MergeFileResolution = TextFileMergeResolution | GltfFileMergeResolution;

export async function resolveMergePr(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  options: { strategy: "ours" | "theirs" } | { files: MergeFileResolution[] },
  commitMessage?: string,
): Promise<{ merged: boolean; sha: string }> {
  const body =
    "strategy" in options
      ? { strategy: options.strategy, commitMessage }
      : { files: options.files, commitMessage };
  return req(`/repos/${handle}/${repoName}/pulls/${number}/merge-resolve`, {
    method: "POST",
    token,
    body: JSON.stringify(body),
  });
}

export async function listPRCommits(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ commits: CommitInfo[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/commits`, { token: token ?? undefined });
}

export async function listPRFiles(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ files: PRFileEntry[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/files`, { token: token ?? undefined });
}

export async function getPRFileDiff(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
  filePath: string,
): Promise<{ files: FileDiff[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/diff?path=${encodeURIComponent(filePath)}`, { token: token ?? undefined });
}

export async function closePull(
  token: string,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ state: string }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ state: "closed" }),
  });
}

export async function reopenPull(
  token: string,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ state: string }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ state: "open" }),
  });
}

// ─── fork ─────────────────────────────────────────────────────────────────────────────

export async function forkRepo(
  token: string,
  handle: string,
  repoName: string,
): Promise<Repo> {
  return req(`/repos/${handle}/${repoName}/fork`, { method: "POST", token });
}

// ─── commits ─────────────────────────────────────────────────────────────────────────────

export async function listCommits(
  token: string | null,
  handle: string,
  repoName: string,
  ref?: string,
  path?: string,
  limit?: number,
): Promise<{ commits: CommitInfo[] }> {
  const qs = new URLSearchParams();
  if (ref) qs.set("branch", ref);
  if (path) qs.set("path", path);
  if (limit) qs.set("limit", String(limit));
  const q = qs.toString() ? `?${qs}` : "";
  return req(`/repos/${handle}/${repoName}/commits${q}`, { token: token ?? undefined });
}

export async function getCommit(
  token: string | null,
  handle: string,
  repoName: string,
  sha: string,
): Promise<CommitDetail> {
  return req(`/repos/${handle}/${repoName}/commits/${sha}`, { token: token ?? undefined });
}

export async function getCommitDiff(
  token: string | null,
  handle: string,
  repoName: string,
  sha: string,
): Promise<{ files: FileDiff[] }> {
  return req(`/repos/${handle}/${repoName}/commits/${sha}/diff`, { token: token ?? undefined });
}

// ─── tree / blob ────────────────────────────────────────────────────────────────────────────

export async function listTree(
  token: string | null,
  handle: string,
  repoName: string,
  ref?: string,
  path?: string,
): Promise<{ entries: TreeEntry[]; readme: { path: string; content: string } | null }> {
  const qs = new URLSearchParams();
  if (ref) qs.set("ref", ref);
  if (path) qs.set("path", path);
  return req(`/repos/${handle}/${repoName}/tree?${qs}`, { token: token ?? undefined });
}

export async function getBlob(
  token: string | null,
  handle: string,
  repoName: string,
  path: string,
  ref?: string,
): Promise<{ path: string; content: string; encoding: string }> {
  const qs = new URLSearchParams({ path });
  if (ref) qs.set("ref", ref);
  return req(`/repos/${handle}/${repoName}/blob?${qs}`, { token: token ?? undefined });
}

export async function getReadme(
  token: string | null,
  handle: string,
  repoName: string,
  ref?: string,
  path?: string,
): Promise<{ path: string; content: string }> {
  const qs = new URLSearchParams();
  if (ref) qs.set("ref", ref);
  if (path) qs.set("path", path);
  const q = qs.toString() ? `?${qs}` : "";
  return req(`/repos/${handle}/${repoName}/readme${q}`, { token: token ?? undefined });
}

// ─── issues ─────────────────────────────────────────────────────────────────────────────

export async function listIssues(
  token: string | null,
  handle: string,
  repoName: string,
  state: "open" | "closed" | "all" = "open",
  label?: string,
  assignee?: string,
  author?: string,
  sort?: "newest" | "oldest",
): Promise<{ issues: Issue[] }> {
  const qs = new URLSearchParams({ state });
  if (label) qs.set("label", label);
  if (assignee) qs.set("assignee", assignee);
  if (author) qs.set("author", author);
  if (sort) qs.set("sort", sort);
  return req(`/repos/${handle}/${repoName}/issues?${qs}`, { token: token ?? undefined });
}

export type RepoMember = { id: string; handle: string; displayName: string | null; role: "owner" | "writer" | "reader" };

export async function listRepoMembers(token: string | null, handle: string, repoName: string): Promise<{ members: RepoMember[] }> {
  return req(`/repos/${handle}/${repoName}/members`, { token: token ?? undefined });
}

export async function getIssue(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}`, { token: token ?? undefined });
}

export async function createIssue(
  token: string,
  handle: string,
  repoName: string,
  title: string,
  body?: string,
  labelIds?: string[],
): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues`, {
    method: "POST",
    token,
    body: JSON.stringify({ title, body, labelIds }),
  });
}

export async function updateIssue(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  patch: { state?: "open" | "closed"; title?: string; body?: string; assigneeId?: string | null },
): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(patch),
  });
}

export async function addIssueLabel(token: string, handle: string, repoName: string, number: number, labelId: string): Promise<void> {
  await req(`/repos/${handle}/${repoName}/issues/${number}/labels`, { method: "POST", token, body: JSON.stringify({ labelId }) });
}

export async function removeIssueLabel(token: string, handle: string, repoName: string, number: number, labelId: string): Promise<void> {
  await req(`/repos/${handle}/${repoName}/issues/${number}/labels/${labelId}`, { method: "DELETE", token });
}

export async function listIssueComments(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ comments: IssueComment[] }> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/comments`, { token: token ?? undefined });
}

export async function createIssueComment(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  body: string,
): Promise<IssueComment> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/comments`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
  });
}

// ─── labels ─────────────────────────────────────────────────────────────────────────────

export async function listLabels(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ labels: Label[] }> {
  return req(`/repos/${handle}/${repoName}/labels`, { token: token ?? undefined });
}

// ─── releases ─────────────────────────────────────────────────────────────────────────────

export async function listReleases(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ releases: Release[] }> {
  return req(`/repos/${handle}/${repoName}/releases`, { token: token ?? undefined });
}

export async function getRelease(
  token: string | null,
  handle: string,
  repoName: string,
  tagName: string,
): Promise<Release> {
  return req(`/repos/${handle}/${repoName}/releases/${encodeURIComponent(tagName)}`, { token: token ?? undefined });
}

export async function createRelease(
  token: string,
  handle: string,
  repoName: string,
  tagName: string,
  releaseName: string,
  body?: string,
  isDraft?: boolean,
  isPrerelease?: boolean,
  targetCommitish?: string,
): Promise<Release> {
  return req(`/repos/${handle}/${repoName}/releases`, {
    method: "POST",
    token,
    body: JSON.stringify({ tagName, name: releaseName, body, isDraft, isPrerelease, targetCommitish }),
  });
}

export async function deleteRelease(
  token: string,
  handle: string,
  repoName: string,
  tagName: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/releases/${encodeURIComponent(tagName)}`, {
    method: "DELETE",
    token,
  });
}

// ─── notifications ────────────────────────────────────────────────────────────────

export async function listNotifications(
  token: string,
  all = false,
): Promise<{ notifications: Notification[] }> {
  return req(`/notifications${all ? "?all=true" : ""}`, { token });
}

export async function markAllNotificationsRead(token: string): Promise<void> {
  return req("/notifications", { method: "PATCH", token });
}

export async function markNotificationRead(token: string, id: string): Promise<void> {
  return req(`/notifications/${id}`, { method: "PATCH", token });
}

export async function deleteNotification(token: string, id: string): Promise<void> {
  return req(`/notifications/${id}`, { method: "DELETE", token });
}

// ─── labels ─────────────────────────────────────────────────────────────────────────────

export async function createLabel(
  token: string,
  handle: string,
  repoName: string,
  name: string,
  color: string,
  description?: string,
): Promise<Label> {
  return req(`/repos/${handle}/${repoName}/labels`, {
    method: "POST",
    token,
    body: JSON.stringify({ name, color, description }),
  });
}

export async function updateLabel(
  token: string,
  handle: string,
  repoName: string,
  labelId: string,
  patch: { name?: string; color?: string; description?: string },
): Promise<Label> {
  return req(`/repos/${handle}/${repoName}/labels/${labelId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(patch),
  });
}

export async function deleteLabel(
  token: string,
  handle: string,
  repoName: string,
  labelId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/labels/${labelId}`, { method: "DELETE", token });
}

// ─── collaborators ────────────────────────────────────────────────────────────────

export type Collaborator = {
  id: string;
  role: "reader" | "writer" | "admin";
  createdAt: string;
  user: { id: string; handle: string; email: string; displayName: string | null };
};

export async function listCollaborators(token: string, repoName: string): Promise<{ collaborators: Collaborator[] }> {
  return req(`/repos/${repoName}/collaborators`, { token });
}

export async function addCollaborator(
  token: string,
  repoName: string,
  handle: string,
  role: "reader" | "writer" | "admin" = "writer",
): Promise<Collaborator> {
  return req(`/repos/${repoName}/collaborators`, {
    method: "POST",
    token,
    body: JSON.stringify({ handle, role }),
  });
}

export async function removeCollaborator(token: string, repoName: string, handle: string): Promise<void> {
  return req(`/repos/${repoName}/collaborators/${handle}`, { method: "DELETE", token });
}

export async function search(
  token: string | null,
  q: string,
  type: "repos" | "issues" | "users",
): Promise<{ type: string; results: unknown[] }> {
  const params = new URLSearchParams({ q, type });
  return req<{ type: string; results: unknown[] }>(`/search?${params}`, { token: token ?? undefined });
}
