import type {
  BlameHunk, BranchInfo, BranchProtection, BranchProtectionRules, CheckSummary, CommitDetail,
  CommitInfo, Composition, Constraint, Contributions, DeployKey, Design, DesignCompareResult, DesignVersion,
  DiffChange, DiffResult, FileDiff, ForkSummary, Issue, IssueComment, Label, Milestone,
  Notification, PRFileEntry, PatScope, PersonalAccessToken, ProjectColumn, ProjectDetail,
  ProjectItem, ProjectSubjectType, ProjectSummary, ProtectedTag, PublicProfile, PullRequest, RefCompareResult,
  Release, ReleaseAsset, Repo, Review, ReviewComment, ReviewCommentPosition, SSHKey, SessionInfo,
  SavedFilter, Snapshot, SnapshotSummary, SyncForkResult, TagInfo, TimelineEvent, TreeEntry,
  User, Webhook, WebhookDelivery, WebhookEvent, WorkflowRun,
} from "./types";

/**
 * An error carrying the HTTP status of a failed API response, so callers can
 * distinguish "not found / not supported" (404) from a genuine failure
 * (500, network). Extends Error, so existing `instanceof Error` / `.message`
 * handling keeps working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * True when a semantic-diff request failed because the format isn't supported
 * for this repo — a 404 from /filediff (no handler registered / repo hasn't
 * opted the format in). Such files should fall back to their base text/binary
 * viewer rather than show an error. Any other failure is genuine.
 */
export function isFormatNotSupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Result of GET /repos/:h/:n/filediff — a format-aware diff for one file blob pair. */
export type SemanticFileDiff = {
  version: string;
  format: string;
  handlerId: string;
  path: string;
  changes: DiffChange[];
  // The commit SHAs the diff was computed from, so a client renderer (e.g. the
  // gltf-scene 3D viewport) can fetch the raw blobs to build geometry. baseSha
  // is null for an added file / root commit.
  baseSha: string | null;
  headSha: string;
};

/** Compute a semantic diff for one file at a commit (base defaults to its parent). */
export async function getFileSemanticDiff(
  token: string | null,
  handle: string,
  repoName: string,
  filePath: string,
  sha: string,
): Promise<SemanticFileDiff> {
  return req(
    `/repos/${handle}/${repoName}/filediff?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(sha)}`,
    { token: token ?? undefined },
  );
}

/**
 * The public FHR format manifest mirrored by the API: maps a lowercase extension
 * WITH its leading dot (e.g. ".gltf") to the handler id that serves it. No auth
 * required. May 503 while the API has never fetched a manifest — callers degrade
 * gracefully (render base viewers) rather than surface the error. ForgeHub holds
 * no per-format list of its own; this endpoint is the sole source of truth for
 * which extensions have semantic support.
 */
export async function getFhrFormats(): Promise<Record<string, string>> {
  const { formats } = await req<{ formats: Record<string, string> }>("/fhr/formats");
  return formats ?? {};
}

/**
 * Fetch the raw bytes of a file at a commit as a Blob (auth-aware).
 * Used by client renderers that need the actual file — the gltf-scene 3D
 * viewport fetches the head/base blobs to build its mesh. The caller wraps the
 * result in an object URL and hands *that* to the renderer, because the renderer
 * fetch()es the url without an Authorization header (SPEC-RENDERING blobs).
 */
export async function fetchRawBlob(
  token: string | null,
  handle: string,
  repoName: string,
  filePath: string,
  sha: string,
): Promise<Blob> {
  const res = await fetch(
    `${BASE}/repos/${handle}/${repoName}/rawblob?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(sha)}`,
    { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}

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
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
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

/** Toggle the current user's global email-notifications preference. */
export async function setEmailNotifications(token: string, enabled: boolean): Promise<{ user: User }> {
  return req("/users/me", { method: "PATCH", token, body: JSON.stringify({ emailNotifications: enabled }) });
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

// ─── composition ─────────────────────────────────────────────────────────────

/** Byte-share per format/domain at a ref (default branch when omitted). */
export async function getComposition(
  token: string | null,
  handle: string,
  repoName: string,
  ref?: string,
): Promise<Composition> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return req(`/repos/${handle}/${repoName}/composition${qs}`, { token: token ?? undefined });
}

// ─── topics ──────────────────────────────────────────────────────────────────

export async function getTopics(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ topics: string[] }> {
  return req(`/repos/${handle}/${repoName}/topics`, { token: token ?? undefined });
}

/** Replace the whole topic set (writer-gated). Returns the persisted, sorted set. */
export async function updateTopics(
  token: string,
  handle: string,
  repoName: string,
  topics: string[],
): Promise<{ topics: string[] }> {
  return req(`/repos/${handle}/${repoName}/topics`, {
    method: "PUT",
    token,
    body: JSON.stringify({ topics }),
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

// ─── branch protection (issue #85) ──────────────────────────────────────────────────────

export async function getBranchProtection(
  token: string | null,
  handle: string,
  repoName: string,
  branch: string,
): Promise<BranchProtection> {
  return req(`/repos/${handle}/${repoName}/branches/${encodeURIComponent(branch)}/protection`, {
    token: token ?? undefined,
  });
}

export async function putBranchProtection(
  token: string,
  handle: string,
  repoName: string,
  branch: string,
  rules: BranchProtectionRules,
): Promise<{ branch: string; protected: boolean; rules: BranchProtectionRules }> {
  return req(`/repos/${handle}/${repoName}/branches/${encodeURIComponent(branch)}/protection`, {
    method: "PUT",
    token,
    body: JSON.stringify(rules),
  });
}

export async function deleteBranchProtection(
  token: string,
  handle: string,
  repoName: string,
  branch: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/branches/${encodeURIComponent(branch)}/protection`, {
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

// ─── protected tags (issue #117) ────────────────────────────────────────────────

export async function listProtectedTags(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ protectedTags: ProtectedTag[] }> {
  return req(`/repos/${handle}/${repoName}/protected-tags`, { token: token ?? undefined });
}

export async function addProtectedTag(
  token: string,
  handle: string,
  repoName: string,
  pattern: string,
): Promise<ProtectedTag> {
  return req(`/repos/${handle}/${repoName}/protected-tags`, {
    method: "POST",
    token,
    body: JSON.stringify({ pattern }),
  });
}

export async function removeProtectedTag(
  token: string,
  handle: string,
  repoName: string,
  id: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/protected-tags/${id}`, { method: "DELETE", token });
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

export type MergeMethod = "merge" | "squash" | "rebase";

export async function mergePull(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  mergeMethod: MergeMethod = "merge",
  commitMessage?: string,
  override?: boolean,
): Promise<{ merged: boolean; sha: string; method: MergeMethod }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/merge`, {
    method: "POST",
    token,
    body: JSON.stringify({ mergeMethod, commitMessage, override }),
  });
}

/**
 * Revert a merged PR: opens a new PR whose branch reverts the merge/squash/
 * rebase commit. Returns the newly created reverting PR. A 409 (ApiError)
 * signals the revert conflicts with the base branch.
 */
export async function revertPull(
  token: string,
  handle: string,
  repoName: string,
  number: number,
): Promise<PullRequest> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/revert`, {
    method: "POST",
    token,
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
  override?: boolean,
): Promise<{ merged: boolean; sha: string }> {
  const body =
    "strategy" in options
      ? { strategy: options.strategy, commitMessage, override }
      : { files: options.files, commitMessage, override };
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

// ─── code navigation: blame / permalinks / archive / ref-compare ───────────────

/** Line-level authorship for a file at a ref, as contiguous commit hunks. */
export async function getBlame(
  token: string | null,
  handle: string,
  repoName: string,
  path: string,
  ref?: string,
): Promise<{ ref: string; path: string; hunks: BlameHunk[] }> {
  const qs = new URLSearchParams({ path });
  if (ref) qs.set("ref", ref);
  return req(`/repos/${handle}/${repoName}/blame?${qs}`, { token: token ?? undefined });
}

/** Resolve a ref (branch/tag/sha) to its canonical 40-char commit SHA — for permalinks. */
export async function resolveRef(
  token: string | null,
  handle: string,
  repoName: string,
  ref: string,
): Promise<{ ref: string; sha: string }> {
  return req(`/repos/${handle}/${repoName}/resolve-ref?ref=${encodeURIComponent(ref)}`, { token: token ?? undefined });
}

/** URL of the streaming source archive for a ref (used for direct links on public repos). */
export function archiveUrl(handle: string, repoName: string, ref: string, format: "zip" | "tar.gz" = "zip"): string {
  const qs = new URLSearchParams({ ref, format });
  return `${BASE}/repos/${handle}/${repoName}/archive?${qs}`;
}

/**
 * Download the source archive for a ref via an authenticated fetch, so private
 * repos work too, then trigger a browser download of the resulting blob.
 */
export async function downloadArchive(
  token: string | null,
  handle: string,
  repoName: string,
  ref: string,
  format: "zip" | "tar.gz" = "zip",
): Promise<void> {
  const res = await fetch(archiveUrl(handle, repoName, ref), {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const refLabel = ref.replace(/[^\w.-]+/g, "-");
  a.href = url;
  a.download = `${repoName}-${refLabel}.${format === "tar.gz" ? "tar.gz" : "zip"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Compare any two refs — ahead/behind, head-introduced commits, changed-file stats. */
export async function getRefCompare(
  token: string | null,
  handle: string,
  repoName: string,
  base: string,
  head: string,
): Promise<RefCompareResult> {
  const qs = new URLSearchParams({ base, head });
  return req(`/repos/${handle}/${repoName}/ref-compare?${qs}`, { token: token ?? undefined });
}

/** Full per-file diffs (with hunks) for a ref comparison, optionally one path. */
export async function getRefCompareDiff(
  token: string | null,
  handle: string,
  repoName: string,
  base: string,
  head: string,
  path?: string,
): Promise<{ files: FileDiff[] }> {
  const qs = new URLSearchParams({ base, head });
  if (path) qs.set("path", path);
  return req(`/repos/${handle}/${repoName}/ref-compare/diff?${qs}`, { token: token ?? undefined });
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
  milestone?: string,
): Promise<{ issues: Issue[] }> {
  const qs = new URLSearchParams({ state });
  if (label) qs.set("label", label);
  if (assignee) qs.set("assignee", assignee);
  if (author) qs.set("author", author);
  if (sort) qs.set("sort", sort);
  if (milestone) qs.set("milestone", milestone);
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
  patch: { state?: "open" | "closed"; title?: string; body?: string; assigneeId?: string | null; milestoneId?: string | null },
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

// ─── issue triage: pin / lock / transfer (#120) ────────────────────────────────

export async function pinIssue(token: string, handle: string, repoName: string, number: number): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/pin`, { method: "POST", token });
}

export async function unpinIssue(token: string, handle: string, repoName: string, number: number): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/pin`, { method: "DELETE", token });
}

export async function lockIssue(token: string, handle: string, repoName: string, number: number, reason?: string): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/lock`, {
    method: "POST", token, body: JSON.stringify({ reason }),
  });
}

export async function unlockIssue(token: string, handle: string, repoName: string, number: number): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/lock`, { method: "DELETE", token });
}

/** Move an issue to another repo owned by the same owner (v0). Returns the new location. */
export async function transferIssue(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  targetRepo: string,
): Promise<{ id: string; number: number; repo: string; handle: string; name: string; url: string }> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/transfer`, {
    method: "POST", token, body: JSON.stringify({ targetRepo }),
  });
}

// ─── saved filter views (#120) — per user, per repo ────────────────────────────

export async function listSavedFilters(token: string, handle: string, repoName: string): Promise<{ savedFilters: SavedFilter[] }> {
  return req(`/repos/${handle}/${repoName}/saved-filters`, { token });
}

export async function createSavedFilter(
  token: string,
  handle: string,
  repoName: string,
  name: string,
  query: string,
  scope: "issue" | "pull_request" = "issue",
): Promise<SavedFilter> {
  return req(`/repos/${handle}/${repoName}/saved-filters`, {
    method: "POST", token, body: JSON.stringify({ name, query, scope: scope.toUpperCase() }),
  });
}

export async function deleteSavedFilter(token: string, handle: string, repoName: string, id: string): Promise<void> {
  return req(`/repos/${handle}/${repoName}/saved-filters/${id}`, { method: "DELETE", token });
}

// ─── milestones (#83) ──────────────────────────────────────────────────────────

export async function listMilestones(
  token: string | null,
  handle: string,
  repoName: string,
  state?: "open" | "closed" | "all",
): Promise<{ milestones: Milestone[]; counts: { open: number; closed: number } }> {
  const qs = state && state !== "all" ? `?state=${state}` : "";
  return req(`/repos/${handle}/${repoName}/milestones${qs}`, { token: token ?? undefined });
}

export async function getMilestone(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<Milestone> {
  return req(`/repos/${handle}/${repoName}/milestones/${number}`, { token: token ?? undefined });
}

export async function createMilestone(
  token: string,
  handle: string,
  repoName: string,
  input: { title: string; description?: string; dueOn?: string | null },
): Promise<Milestone> {
  return req(`/repos/${handle}/${repoName}/milestones`, { method: "POST", token, body: JSON.stringify(input) });
}

export async function updateMilestone(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  patch: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" },
): Promise<Milestone> {
  return req(`/repos/${handle}/${repoName}/milestones/${number}`, { method: "PATCH", token, body: JSON.stringify(patch) });
}

export async function deleteMilestone(token: string, handle: string, repoName: string, number: number): Promise<void> {
  return req(`/repos/${handle}/${repoName}/milestones/${number}`, { method: "DELETE", token });
}

/** Set (or clear, with null) the milestone on an issue. Writer-gated on the server. */
export async function setIssueMilestone(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  milestoneId: string | null,
): Promise<Issue> {
  return updateIssue(token, handle, repoName, number, { milestoneId });
}

// ─── timelines & PR conversation ─────────────────────────────────────────────────────────

export async function listIssueTimeline(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ events: TimelineEvent[] }> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/timeline`, { token: token ?? undefined });
}

export async function listPullTimeline(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ events: TimelineEvent[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/timeline`, { token: token ?? undefined });
}

export async function listPullComments(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ comments: IssueComment[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/comments`, { token: token ?? undefined });
}

export async function createPullComment(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  body: string,
): Promise<IssueComment> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/comments`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
  });
}

// ─── quick actions + time tracking (issue #122) ───────────────────────────────────────────

/** One quick action that was applied or rejected when a comment was posted. */
export type QuickAction = { command: string; summary?: string; reason?: string };

/** Applied/rejected quick-action summary the UI can toast after posting a comment. */
export type CommentActionSummary = { applied: QuickAction[]; rejected: QuickAction[] };

/** A posted comment plus the quick-action summary. `comment` is null for a command-only body. */
export type CommentWithActions = { comment: IssueComment | null; actions: CommentActionSummary };

/**
 * Post an issue comment and surface any quick actions (`/close`, `/label …`,
 * `/estimate 2h` …) it triggered. Command lines are stripped server-side; if the
 * body was only commands, `comment` comes back null but the actions still applied.
 */
export async function createIssueCommentWithActions(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  body: string,
): Promise<CommentWithActions> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/comments`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
  });
}

/** Post a PR comment, surfacing any quick actions (on PRs: `/close`, `/reopen`). */
export async function createPullCommentWithActions(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  body: string,
): Promise<CommentWithActions> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/comments`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
  });
}

/** Set an issue's time estimate (absolute whole minutes; 0 clears it). Writer-only. */
export async function setIssueEstimate(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  minutes: number,
): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/estimate`, {
    method: "PUT",
    token,
    body: JSON.stringify({ minutes }),
  });
}

/** Set an issue's total spent time (absolute whole minutes; 0 clears it). Writer-only. */
export async function setIssueSpent(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  minutes: number,
): Promise<Issue> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/spent`, {
    method: "PUT",
    token,
    body: JSON.stringify({ minutes }),
  });
}

// ─── PR reviews: submissions, inline comments, threads ──────────────────────────

export type ReviewVerdict = "approved" | "changes_requested" | "commented";

/** All reviews visible to the caller (submitted reviews + the caller's own draft). */
export async function listReviews(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ reviews: Review[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/reviews`, { token: token ?? undefined });
}

/** All visible inline review comments (submitted, plus the caller's own drafts). */
export async function listReviewComments(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ comments: ReviewComment[] }> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments`, { token: token ?? undefined });
}

/**
 * Add an inline review comment. Auto-attaches to (or opens) the caller's pending
 * review; the returned comment carries its `reviewId` so a single-comment flow can
 * immediately submit that review.
 */
export async function createReviewComment(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  input: { body: string; filePath: string; position: ReviewCommentPosition },
): Promise<ReviewComment> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments`, {
    method: "POST",
    token,
    body: JSON.stringify(input),
  });
}

/** Submit a fresh review (summary only — no pre-composed inline drafts). */
export async function createReview(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  input: { state: ReviewVerdict; body?: string },
): Promise<Review> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/reviews`, {
    method: "POST",
    token,
    body: JSON.stringify(input),
  });
}

/** Submit the caller's pending review (folding in its draft inline comments). */
export async function submitReview(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  reviewId: string,
  input: { state: ReviewVerdict; body?: string },
): Promise<Review> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/reviews/${reviewId}`, {
    method: "PUT",
    token,
    body: JSON.stringify(input),
  });
}

/** Discard the caller's pending (draft) review. */
export async function deleteReview(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  reviewId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/reviews/${reviewId}`, { method: "DELETE", token });
}

/** Reply to a review thread (attaches to the thread's root review). */
export async function replyToReviewThread(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  commentId: string,
  body: string,
): Promise<ReviewComment> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments/${commentId}/replies`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
  });
}

/** Resolve (true) or unresolve (false) a review thread by any comment in it. */
export async function setReviewThreadResolved(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  commentId: string,
  resolved: boolean,
): Promise<ReviewComment> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments/${commentId}/resolve`, {
    method: resolved ? "POST" : "DELETE",
    token,
  });
}

/** Edit an inline review comment body (author only). */
export async function updateReviewComment(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  commentId: string,
  body: string,
): Promise<ReviewComment> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments/${commentId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ body }),
  });
}

/** Delete an inline review comment (author or repo owner). */
export async function deleteReviewComment(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  commentId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/pulls/${number}/review-comments/${commentId}`, { method: "DELETE", token });
}

// ─── projects: board + table over issues/PRs (issue #84) ───────────────────────

export async function listProjects(
  token: string | null,
  handle: string,
  repoName: string,
  state: "open" | "closed" | "all" = "open",
): Promise<{ projects: ProjectSummary[] }> {
  return req(`/repos/${handle}/${repoName}/projects?state=${state}`, { token: token ?? undefined });
}

export async function createProject(
  token: string,
  handle: string,
  repoName: string,
  name: string,
  description?: string,
): Promise<ProjectDetail> {
  return req(`/repos/${handle}/${repoName}/projects`, {
    method: "POST",
    token,
    body: JSON.stringify({ name, description }),
  });
}

export async function getProject(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<ProjectDetail> {
  return req(`/repos/${handle}/${repoName}/projects/${number}`, { token: token ?? undefined });
}

export async function updateProject(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  patch: { name?: string; description?: string | null; closed?: boolean },
): Promise<ProjectDetail> {
  return req(`/repos/${handle}/${repoName}/projects/${number}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(patch),
  });
}

export async function deleteProject(
  token: string,
  handle: string,
  repoName: string,
  number: number,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/projects/${number}`, { method: "DELETE", token });
}

export async function createProjectColumn(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  name: string,
): Promise<ProjectColumn> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/columns`, {
    method: "POST",
    token,
    body: JSON.stringify({ name }),
  });
}

export async function renameProjectColumn(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  columnId: string,
  name: string,
): Promise<{ id: string; name: string; position: number }> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/columns/${columnId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ name }),
  });
}

export async function reorderProjectColumns(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  order: string[],
): Promise<{ columns: { id: string; name: string; position: number }[] }> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/columns/order`, {
    method: "PUT",
    token,
    body: JSON.stringify({ order }),
  });
}

export async function deleteProjectColumn(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  columnId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/columns/${columnId}`, { method: "DELETE", token });
}

export async function addProjectItem(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  columnId: string,
  type: ProjectSubjectType,
  subjectNumber: number,
): Promise<ProjectItem> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/items`, {
    method: "POST",
    token,
    body: JSON.stringify({ columnId, type, number: subjectNumber }),
  });
}

/**
 * Move an item to `columnId` at 0-based `position` within that column. The
 * server renumbers the affected column(s) densely, so an optimistic client that
 * inserted at the same index stays in sync.
 */
export async function moveProjectItem(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  itemId: string,
  columnId: string,
  position: number,
): Promise<{ id: string; columnId: string; position: number; subjectType: ProjectSubjectType; subjectNumber: number }> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/items/${itemId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ columnId, position }),
  });
}

export async function removeProjectItem(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  itemId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/projects/${number}/items/${itemId}`, { method: "DELETE", token });
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

// ─── release assets ─────────────────────────────────────────────────────────────────────────

/** Direct API URL for an asset's bytes (usable as an <a href> on public repos). */
export function releaseAssetDownloadUrl(
  handle: string,
  repoName: string,
  releaseId: string,
  assetId: string,
): string {
  return `${BASE}/repos/${handle}/${repoName}/releases/${releaseId}/assets/${assetId}`;
}

/** Fetch an asset with auth and trigger a browser download (works for private repos too). */
export async function downloadReleaseAsset(
  token: string | null,
  handle: string,
  repoName: string,
  releaseId: string,
  asset: ReleaseAsset,
): Promise<void> {
  const res = await fetch(releaseAssetDownloadUrl(handle, repoName, releaseId, asset.id), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = asset.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Upload a binary asset to a release, reporting progress (0..1) via a callback. */
export function uploadReleaseAsset(
  token: string,
  handle: string,
  repoName: string,
  releaseId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<ReleaseAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/repos/${handle}/${repoName}/releases/${releaseId}/assets`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ReleaseAsset);
        } catch {
          reject(new ApiError(xhr.status, "Malformed server response"));
        }
      } else {
        let message = `HTTP ${xhr.status}`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
        } catch { /* keep default */ }
        reject(new ApiError(xhr.status, message));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export async function deleteReleaseAsset(
  token: string,
  handle: string,
  repoName: string,
  releaseId: string,
  assetId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/releases/${releaseId}/assets/${assetId}`, {
    method: "DELETE",
    token,
  });
}

/** Generate a Markdown changelog for a target ref vs the previous tag (or root). */
export async function generateReleaseNotes(
  token: string,
  handle: string,
  repoName: string,
  tagName: string,
  target?: string,
  previousTag?: string,
): Promise<{ tagName: string; previousTag: string | null; body: string }> {
  return req(`/repos/${handle}/${repoName}/releases/generate-notes`, {
    method: "POST",
    token,
    body: JSON.stringify({ tagName, target, previousTag }),
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

// ─── personal access tokens ─────────────────────────────────────────────────────

export async function listTokens(token: string): Promise<{ tokens: PersonalAccessToken[] }> {
  return req("/auth/tokens", { token });
}

export async function createToken(
  token: string,
  name: string,
  expiresInDays?: number,
  scopes?: PatScope[],
): Promise<PersonalAccessToken & { token: string }> {
  return req("/auth/tokens", {
    method: "POST",
    token,
    body: JSON.stringify({ name, expiresInDays, scopes }),
  });
}

export async function revokeToken(token: string, id: string): Promise<void> {
  return req(`/auth/tokens/${id}`, { method: "DELETE", token });
}

// ─── interactive login sessions (issue #117) ─────────────────────────────────────

export async function listSessions(token: string): Promise<{ sessions: SessionInfo[] }> {
  return req("/auth/sessions", { token });
}

/** Revoke a single session ("sign out this device"). */
export async function revokeSession(token: string, id: string): Promise<void> {
  return req(`/auth/sessions/${id}`, { method: "DELETE", token });
}

/** Revoke every session except the current one ("sign out everywhere"). */
export async function revokeOtherSessions(token: string): Promise<{ revoked: number }> {
  return req("/auth/sessions", { method: "DELETE", token });
}

// ─── webhooks (issue #87) ───────────────────────────────────────────────────────

export async function listWebhooks(token: string, handle: string, repoName: string): Promise<{ hooks: Webhook[] }> {
  return req(`/repos/${handle}/${repoName}/hooks`, { token });
}

export async function createWebhook(
  token: string,
  handle: string,
  repoName: string,
  input: { url: string; secret: string; events?: WebhookEvent[]; active?: boolean },
): Promise<Webhook> {
  return req(`/repos/${handle}/${repoName}/hooks`, { method: "POST", token, body: JSON.stringify(input) });
}

export async function updateWebhook(
  token: string,
  handle: string,
  repoName: string,
  id: string,
  patch: { url?: string; secret?: string; events?: WebhookEvent[]; active?: boolean },
): Promise<Webhook> {
  return req(`/repos/${handle}/${repoName}/hooks/${id}`, { method: "PATCH", token, body: JSON.stringify(patch) });
}

export async function deleteWebhook(token: string, handle: string, repoName: string, id: string): Promise<void> {
  return req(`/repos/${handle}/${repoName}/hooks/${id}`, { method: "DELETE", token });
}

export async function listWebhookDeliveries(
  token: string,
  handle: string,
  repoName: string,
  id: string,
): Promise<{ deliveries: WebhookDelivery[] }> {
  return req(`/repos/${handle}/${repoName}/hooks/${id}/deliveries`, { token });
}

export async function redeliverWebhookDelivery(
  token: string,
  handle: string,
  repoName: string,
  hookId: string,
  deliveryId: string,
): Promise<WebhookDelivery> {
  return req(`/repos/${handle}/${repoName}/hooks/${hookId}/deliveries/${deliveryId}/redeliver`, { method: "POST", token });
}

export type SearchType = "repos" | "issues" | "users" | "code" | "entities";

/**
 * Unified search. `code` fans a bounded `git grep` across readable repos and
 * `entities` queries the FHR Entity table (name/kind) — both visibility-scoped
 * server-side. The envelope carries type-specific extras (e.g. `truncated`,
 * `timedOut`, `reposSearched` for code), so callers read `results` plus whatever
 * else the type provides.
 */
export async function search(
  token: string | null,
  q: string,
  type: SearchType,
): Promise<{ type: string; results: unknown[]; truncated?: boolean; timedOut?: boolean; reposSearched?: number }> {
  const params = new URLSearchParams({ q, type });
  return req(`/search?${params}`, { token: token ?? undefined });
}

/** Result of the repo-scoped code-search endpoint (`git grep` at a ref). */
export type RepoCodeSearchResponse = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  ref: string;
  sha: string;
  files: { path: string; matches: { line: number; preview: string }[] }[];
  totalMatches: number;
  truncated: boolean;
  timedOut: boolean;
};

/** Search one repository's file contents at a ref. Deep-links use the returned `sha`. */
export async function codeSearchRepo(
  token: string | null,
  handle: string,
  repoName: string,
  q: string,
  opts: { ref?: string; regex?: boolean; caseSensitive?: boolean; limit?: number } = {},
): Promise<RepoCodeSearchResponse> {
  const qs = new URLSearchParams({ q });
  if (opts.ref) qs.set("ref", opts.ref);
  if (opts.regex) qs.set("regex", "true");
  if (opts.caseSensitive) qs.set("case", "sensitive");
  if (opts.limit) qs.set("limit", String(opts.limit));
  return req(`/repos/${handle}/${repoName}/code-search?${qs}`, { token: token ?? undefined });
}

// ─── Actions-style CI (issue #86) ────────────────────────────────────────────────

/**
 * Aggregate check counts for a commit. Throws ApiError(404) when the commit has
 * no runs — callers treat that as "no checks" (see isFormatNotSupported pattern).
 */
export async function getCheckSummary(
  token: string | null,
  handle: string,
  repoName: string,
  sha: string,
): Promise<CheckSummary> {
  return req(`/repos/${handle}/${repoName}/commits/${sha}/check-summary`, { token: token ?? undefined });
}

/** Batch per-sha check summaries for the commit list (only shas with runs appear). */
export async function getCommitStatuses(
  token: string | null,
  handle: string,
  repoName: string,
  shas: string[],
): Promise<{ statuses: Record<string, CheckSummary> }> {
  if (shas.length === 0) return { statuses: {} };
  const qs = new URLSearchParams({ shas: shas.join(",") });
  return req(`/repos/${handle}/${repoName}/commit-statuses?${qs}`, { token: token ?? undefined });
}

/** List workflow runs for a repo, optionally scoped to one sha or PR. */
export async function listWorkflowRuns(
  token: string | null,
  handle: string,
  repoName: string,
  opts: { sha?: string; prId?: string } = {},
): Promise<{ runs: WorkflowRun[] }> {
  const qs = new URLSearchParams();
  if (opts.sha) qs.set("sha", opts.sha);
  if (opts.prId) qs.set("prId", opts.prId);
  const suffix = qs.toString() ? `?${qs}` : "";
  return req(`/repos/${handle}/${repoName}/actions/runs${suffix}`, { token: token ?? undefined });
}

/** One workflow run with its check runs. */
export async function getWorkflowRun(
  token: string | null,
  handle: string,
  repoName: string,
  id: string,
): Promise<WorkflowRun> {
  return req(`/repos/${handle}/${repoName}/actions/runs/${id}`, { token: token ?? undefined });
}

/** Fetch a job's plain-text log. */
export async function getCheckLog(
  token: string | null,
  handle: string,
  repoName: string,
  runId: string,
  checkId: string,
): Promise<string> {
  const res = await fetch(
    `${BASE}/repos/${handle}/${repoName}/actions/runs/${runId}/checks/${checkId}/log`,
    { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

// ─── fork lineage & sync (issue #113) ─────────────────────────────────────────

/** Direct forks of a repo the caller is allowed to see. */
export async function listForks(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ forks: ForkSummary[] }> {
  return req(`/repos/${handle}/${repoName}/forks`, { token: token ?? undefined });
}

/**
 * Pull upstream changes into a fork's default branch. Fast-forwards when the
 * fork is behind-only; a diverged fork is reported (never force-synced), leaving
 * the caller to open a pull request from the parent instead.
 */
export async function syncFork(
  token: string,
  handle: string,
  repoName: string,
): Promise<SyncForkResult> {
  return req(`/repos/${handle}/${repoName}/sync`, { method: "POST", token });
}

/** Re-run a workflow run: creates + enqueues a fresh run for the same commit. Writer-only. */
export async function rerunWorkflowRun(
  token: string | null,
  handle: string,
  repoName: string,
  id: string,
): Promise<WorkflowRun> {
  return req(`/repos/${handle}/${repoName}/actions/runs/${id}/rerun`, {
    method: "POST",
    token: token ?? undefined,
  });
}

/** Cancel a queued/running workflow run. Writer-only; 409 if already completed. */
export async function cancelWorkflowRun(
  token: string | null,
  handle: string,
  repoName: string,
  id: string,
): Promise<WorkflowRun> {
  return req(`/repos/${handle}/${repoName}/actions/runs/${id}/cancel`, {
    method: "POST",
    token: token ?? undefined,
  });
}

// ─── design management (#121) ──────────────────────────────────────────────────
//
// Design/artifact files attach to an issue and version across uploads. FHR
// formats gain the SAME semantic diff as PR diffs; images get a visual before/
// after; everything else a byte summary — the compare `mode` selects the render.

/** List the designs attached to an issue, each with its version history. */
export async function listDesigns(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
): Promise<{ designs: Design[] }> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/designs`, { token: token ?? undefined });
}

/** Upload a file as a new design or a new version of an existing one (same name). */
export async function uploadDesign(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  file: File,
): Promise<{ design: Design; version: DesignVersion }> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${BASE}/repos/${handle}/${repoName}/issues/${number}/designs`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ design: Design; version: DesignVersion }>;
}

/** Raw-bytes URL for one design version (auth-aware fetches wrap it in an object URL). */
export function designVersionRawUrl(
  handle: string,
  repoName: string,
  number: number,
  designId: string,
  version: number,
): string {
  return `${BASE}/repos/${handle}/${repoName}/issues/${number}/designs/${designId}/versions/${version}/raw`;
}

/**
 * Fetch a design version's bytes as a Blob (auth-aware). Wrapped in an object URL
 * by the gallery/visual-diff so <img> works on private repos without an
 * Authorization header — the same pattern the FHR file-diff viewer uses.
 */
export async function fetchDesignVersionBlob(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
  designId: string,
  version: number,
): Promise<Blob> {
  const res = await fetch(designVersionRawUrl(handle, repoName, number, designId, version), {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}

/** Compare two versions of a design (semantic / visual / binary by `mode`). */
export async function compareDesignVersions(
  token: string | null,
  handle: string,
  repoName: string,
  number: number,
  designId: string,
  from: number,
  to: number,
): Promise<DesignCompareResult> {
  return req(
    `/repos/${handle}/${repoName}/issues/${number}/designs/${designId}/compare?from=${from}&to=${to}`,
    { token: token ?? undefined },
  );
}

/** Delete a design and all its versions (author or repo writer). */
export async function deleteDesign(
  token: string,
  handle: string,
  repoName: string,
  number: number,
  designId: string,
): Promise<void> {
  return req(`/repos/${handle}/${repoName}/issues/${number}/designs/${designId}`, { method: "DELETE", token });
}

// ─── SSH keys + deploy keys (issue #116) ──────────────────────────────────────

export async function listSSHKeys(token: string): Promise<{ keys: SSHKey[] }> {
  return req("/user/keys", { token });
}

export async function addSSHKey(token: string, title: string, publicKey: string): Promise<SSHKey> {
  return req("/user/keys", { method: "POST", token, body: JSON.stringify({ title, publicKey }) });
}

export async function deleteSSHKey(token: string, id: string): Promise<void> {
  return req(`/user/keys/${id}`, { method: "DELETE", token });
}

export async function listDeployKeys(token: string, handle: string, repoName: string): Promise<{ keys: DeployKey[] }> {
  return req(`/repos/${handle}/${repoName}/keys`, { token });
}

export async function addDeployKey(
  token: string,
  handle: string,
  repoName: string,
  input: { title: string; publicKey: string; readOnly: boolean },
): Promise<DeployKey> {
  return req(`/repos/${handle}/${repoName}/keys`, { method: "POST", token, body: JSON.stringify(input) });
}

export async function deleteDeployKey(token: string, handle: string, repoName: string, id: string): Promise<void> {
  return req(`/repos/${handle}/${repoName}/keys/${id}`, { method: "DELETE", token });
}

/**
 * Build the `ssh://git@host:port/owner/repo.git` clone URL shown in the clone box
 * (issue #116). The port comes from server config; the host uses the server's
 * explicit override when set, otherwise the browser's current hostname.
 */
export function sshCloneUrl(opts: {
  handle: string;
  repoName: string;
  sshPort: number;
  sshHost?: string | null;
  hostname: string;
}): string {
  const host = opts.sshHost || opts.hostname;
  return `ssh://git@${host}:${opts.sshPort}/${opts.handle}/${opts.repoName}.git`;
}

// ─── Profiles: avatar + contribution graph (issue #115) ────────────────────────

/**
 * Build the avatar image URL for a handle. When `avatarKey` is known it is
 * appended as `?v=` so a re-upload busts the (immutable) browser cache. Returns
 * null when the user has no uploaded avatar, so callers can fall back to the
 * deterministic letter avatar.
 */
export function avatarSrc(handle: string, avatarKey?: string | null): string | null {
  if (!avatarKey) return null;
  return `${BASE}/users/${handle}/avatar?v=${encodeURIComponent(avatarKey)}`;
}

/** Upload (or replace) the current user's avatar. Returns the rotated token. */
export async function uploadAvatar(
  token: string,
  file: File,
): Promise<{ avatarKey: string; contentType: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/users/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ avatarKey: string; contentType: string; size: number }>;
}

/** Clear the current user's avatar. */
export async function deleteAvatar(token: string): Promise<void> {
  return req("/users/me/avatar", { method: "DELETE", token });
}

/** A user's contribution activity for the calendar heatmap (defaults to ~12 months). */
export async function getContributions(
  token: string | null,
  handle: string,
  from?: string,
  to?: string,
): Promise<Contributions> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const q = qs.toString() ? `?${qs}` : "";
  return req(`/users/${handle}/contributions${q}`, { token: token ?? undefined });
}
