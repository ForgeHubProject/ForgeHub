import type { BranchInfo, Constraint, DiffResult, PullRequest, Repo, Snapshot, SnapshotSummary, TagInfo, User } from "./types";

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
): Promise<Snapshot> {
  return req(`/repos/${handle}/${repoName}/snapshots`, {
    method: "POST",
    token,
    body: JSON.stringify({ gltf, label, sourceFile }),
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
  return req(
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

// ─── tags ─────────────────────────────────────────────────────────────────────

export async function listTags(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ tags: TagInfo[] }> {
  return req(`/repos/${handle}/${repoName}/tags`, { token: token ?? undefined });
}

// ─── pull requests ────────────────────────────────────────────────────────────

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

// ─── fork ─────────────────────────────────────────────────────────────────────

export async function forkRepo(
  token: string,
  handle: string,
  repoName: string,
): Promise<Repo> {
  return req(`/repos/${handle}/${repoName}/fork`, { method: "POST", token });
}
