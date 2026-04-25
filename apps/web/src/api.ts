import type { Constraint, Repo, Snapshot, SnapshotSummary, User } from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

async function req<T>(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
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

export async function getSnapshots(
  token: string | null,
  handle: string,
  repoName: string,
): Promise<{ snapshots: SnapshotSummary[] }> {
  return req(`/repos/${handle}/${repoName}/snapshots`, { token: token ?? undefined });
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
