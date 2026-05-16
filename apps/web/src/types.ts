export type User = {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
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

export type DiffChangeType = "added" | "removed" | "modified" | "moved" | "unchanged";

export type DiffChange = {
  entityId: string;
  name: string;
  kind: string;
  path: string;
  type: DiffChangeType;
  fieldChanges: Array<{ field: string; before: unknown; after: unknown }>;
  before: DiffEntitySnapshot | null;
  after: DiffEntitySnapshot | null;
};

export type GlTfDiffResult = {
  kind?: "gltf-scene";
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: { added: number; removed: number; modified: number; moved: number; unchanged: number };
  changes: DiffChange[];
};

export type TextDiffLineRow = {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type PlainTextDiffResult = {
  kind: "plain-text";
  baseSnapshotId: string;
  targetSnapshotId: string;
  summary: { added: number; removed: number; unchanged: number };
  lines: TextDiffLineRow[];
};

/** Result of GET /compare — discriminated by `kind` or presence of `lines` vs `changes`. */
export type DiffResult = GlTfDiffResult | PlainTextDiffResult;

export function isPlainTextDiff(d: DiffResult | null): d is PlainTextDiffResult {
  return d !== null && "lines" in d;
}

export function isGlTfDiff(d: DiffResult | null): d is GlTfDiffResult {
  return d !== null && "changes" in d;
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
