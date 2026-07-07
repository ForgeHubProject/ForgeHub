export type User = {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  createdAt?: string;
};

export type PersonalAccessToken = {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type PublicProfile = {
  id: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  createdAt: string;
};

export type Repo = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerHandle: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotSummary = {
  id: string;
  handlerId: string;
  label: string | null;
  sourceFile: string;
  schemaVersion: string;
  createdAt: string;
  gitCommitSha: string | null;
};

export type Transform = {
  position: [number, number, number];
  rotationEulerDeg: [number, number, number];
  scale: [number, number, number];
};

export type Entity = {
  id: string;
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  transform: Transform | null;
  attributes: Record<string, unknown>;
  renderRef: { type: string; meshIndex: number } | null;
};

export type Constraint = {
  id: string;
  entityAId: string;
  entityBId: string;
  positionFixed: boolean;
  rotationFixed: boolean;
  createdAt: string;
};

export type Snapshot = SnapshotSummary & {
  repoId: string;
  /** Present when handler stores UTF-8 inline (e.g. plain-text). */
  snapshotBody: string | null;
  entities: Entity[];
  constraints: Constraint[];
};

export type TreeNode = Entity & { children: TreeNode[] };

export type DiffEntitySnapshot = {
  entityId: string;
  parentEntityId: string | null;
  kind: string;
  name: string;
  path: string;
  transform: Transform | null;
  attributes: Record<string, unknown>;
};

/** Change kind in the Forge wire format. */
export type ChangeKind = "added" | "removed" | "modified";

/** Extended change type used by the gltf-scene format (includes "moved" / "unchanged" derived from children). */
export type DiffChangeType = "added" | "removed" | "modified" | "moved" | "unchanged";

/** Forge wire-format diff change node. `before`/`after` carry format-specific payloads. */
export type DiffChange = {
  path: string;
  kind: ChangeKind;
  label?: string;
  before?: unknown;
  after?: unknown;
  children?: DiffChange[];
};

export type TextDiffLineRow = {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

/** Result of GET /compare — unified Forge wire format envelope. */
export type DiffResult = {
  version: "1.0";
  format: string;
  baseSnapshotId: string;
  targetSnapshotId: string;
  changes: DiffChange[];
  /** Full line-by-line diff including unchanged lines — present only for `format: "text"`. */
  lines?: TextDiffLineRow[];
};

export function isPlainTextDiff(d: DiffResult | null): d is DiffResult & { format: "text"; lines: TextDiffLineRow[] } {
  return d !== null && d.format === "text";
}

export function isGlTfDiff(d: DiffResult | null): d is DiffResult & { format: "gltf-scene" } {
  return d !== null && d.format === "gltf-scene";
}

/** Extract the gltf entity payload from a DiffChange (before ?? after). */
export function gltfEntityOf(c: DiffChange): DiffEntitySnapshot | null {
  const payload = c.before ?? c.after;
  if (!payload || typeof payload !== "object") return null;
  return payload as DiffEntitySnapshot;
}

/** Derive a DiffChangeType from a DiffChange, detecting "moved" (transform-only children). */
export function gltfChangeType(c: DiffChange): DiffChangeType {
  if (c.kind === "added") return "added";
  if (c.kind === "removed") return "removed";
  const children = c.children ?? [];
  if (children.length > 0 && children.every((ch) => ["position", "rotation", "scale"].includes(ch.path))) return "moved";
  return "modified";
}

export type BranchInfo = {
  name: string;
  sha: string;
  subject: string;
  date: string;
  isDefault: boolean;
  protected: boolean;
};

export type TagInfo = {
  name: string;
  sha: string;
  subject: string;
  date: string;
};

export type PRFileEntry = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: "added" | "modified" | "deleted" | "renamed";
};

export type PullRequest = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  fromBranch: string;
  toBranch: string;
  state: "open" | "merged" | "closed";
  mergeable?: boolean | null;
  mergedAt: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type CommitInfo = {
  sha: string;
  shortSha: string;
  message: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parents: string[];
};

export type DiffLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  oldPath: string;
  newPath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
};

export type CommitDetail = CommitInfo & {
  changedFiles: string[];
};

export type TreeEntry = {
  mode: string;
  type: "blob" | "tree";
  sha: string;
  name: string;
  path: string;
};

export type Label = {
  id: string;
  name: string;
  color: string;
  description: string | null;
};

export type Issue = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  author: string;
  assignee: string | null;
  labels: Label[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type IssueComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type Release = {
  id: string;
  tagName: string;
  name: string;
  body: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type Notification = {
  id: string;
  subjectType: "issue" | "pull_request" | "release";
  subjectId: string;
  subjectTitle: string;
  reason: "assigned" | "comment" | "review_requested" | "subscribed";
  read: boolean;
  repo: string;
  updatedAt: string;
};

export type SearchRepoResult = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerHandle: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchIssueResult = {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  createdAt: string;
  updatedAt: string;
  repo: { name: string; ownerHandle: string };
};

export type SearchUserResult = {
  id: string;
  handle: string;
  displayName: string | null;
  createdAt: string;
};
