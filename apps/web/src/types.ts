export type User = {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  /** Global opt-in for email delivery of notifications. */
  emailNotifications?: boolean;
  /** Rotating cache-buster token; non-null ⇒ the user has an uploaded avatar (issue #115). */
  avatarKey?: string | null;
  createdAt?: string;
};

/** v0 PAT scopes (issue #87). `admin` ⊇ `repo:write` ⊇ `repo:read`. */
export type PatScope = "repo:read" | "repo:write" | "admin";

export type PersonalAccessToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

// ─── Outbound webhooks (issue #87) ────────────────────────────────────────────

/** Subscribable webhook events shown as checkboxes; "*" means all. */
export type WebhookEvent = "push" | "issues" | "issue_comment" | "pull_request" | "release";

export type Webhook = {
  id: string;
  url: string;
  /** Subscribed events, or ["*"] for all. */
  events: (WebhookEvent | "*")[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
  redeliveredFromId: string | null;
  createdAt: string;
};

// ─── SSH keys + deploy keys (issue #116) ──────────────────────────────────────

/** A user's SSH public key. The public key is public, so it's returned in full. */
export type SSHKey = {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: string | null;
  createdAt: string;
};

/** A repo-scoped deploy key; `readOnly` false means it may also push. */
export type DeployKey = {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  readOnly: boolean;
  createdAt: string;
};

export type PublicProfile = {
  id: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  /** Rotating cache-buster token; non-null ⇒ the user has an uploaded avatar (issue #115). */
  avatarKey: string | null;
  createdAt: string;
};

/** Best-effort license detection (SPDX id + the file it was read from). */
export type RepoLicense = { spdxId: string; path: string };

export type Repo = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerHandle: string;
  fullName: string;
  /** Lowercase-kebab discovery topics (may be absent on older list payloads). */
  topics?: string[];
  /** Detected license — present only on the repo detail payload; null when none. */
  license?: RepoLicense | null;
  /** Fork lineage (issue #113) — populated on the repo detail payload. */
  parent?: ForkRef | null;
  /** Root of the fork chain; equals `parent` for a single-level fork. */
  source?: ForkRef | null;
  /** Number of direct forks the viewer is allowed to see. */
  forkCount?: number;
  /** SSH transport port from server config (issue #116); null/absent = SSH disabled. */
  sshPort?: number | null;
  /** Optional explicit SSH host override; when null the browser hostname is used. */
  sshHost?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A repo referenced in a fork chain — owner handle + repo name. */
export type ForkRef = { handle: string; name: string };

/** One entry in a repo's forks list (`GET /repos/:handle/:name/forks`). */
export type ForkSummary = {
  id: string;
  name: string;
  ownerHandle: string;
  fullName: string;
  description: string | null;
  visibility: "public" | "private";
  updatedAt: string;
};

/** Outcome of a sync-fork action (`POST /repos/:handle/:name/sync`). */
export type SyncForkResult = {
  status: "up-to-date" | "fast-forwarded" | "diverged";
  ahead: number;
  behind: number;
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

// ─── Design management (#121) ────────────────────────────────────────────────────

/** One uploaded version of a design attached to an issue. */
export type DesignVersion = {
  version: number;
  contentType: string;
  size: number;
  /** Carries an ingested entity tree (semantic-diff capable). */
  hasSnapshot: boolean;
  /** Renders inline as an image (visual-diff capable). */
  isImage: boolean;
  uploadedBy: string | null;
  createdAt: string;
};

/** A design (named file) attached to an issue, with its version history. */
export type Design = {
  id: string;
  name: string;
  currentVersion: number;
  /** The format has an FHR handler (semantic diffing available when ingested). */
  semantic: boolean;
  isImage: boolean;
  createdBy: string | null;
  createdAt: string;
  versions: DesignVersion[];
};

/** Result of comparing two design versions — `mode` selects the render path. */
export type DesignCompareResult =
  | { mode: "semantic"; handlerId: string; format: string; version: string; from: number; to: number; changes: DiffChange[] }
  | { mode: "visual"; from: DesignVersionRef; to: DesignVersionRef }
  | { mode: "binary"; from: DesignVersionRef; to: DesignVersionRef };

export type DesignVersionRef = { version: number; contentType: string; size: number };

export type BranchInfo = {
  name: string;
  sha: string;
  subject: string;
  date: string;
  isDefault: boolean;
  protected: boolean;
  /** Commits this branch is ahead of / behind the default branch. */
  ahead?: number;
  behind?: number;
};

/** A contiguous run of lines attributed to one commit (git blame). */
export type BlameHunk = {
  sha: string;
  shortSha: string;
  author: string;
  authorMail: string;
  date: string;
  summary: string;
  startLine: number;
  endLine: number;
  lines: string[];
};

/** Result of GET /ref-compare — arbitrary ref-to-ref comparison. */
export type RefCompareResult = {
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  ahead: number;
  behind: number;
  identical: boolean;
  commits: CommitInfo[];
  files: PRFileEntry[];
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

/** Latest-submitted review state for one reviewer (server-computed). */
export type ReviewerSummary = {
  author: string;
  state: "approved" | "changes_requested" | "commented";
  stale: boolean;
  submittedAt: string | null;
  commitSha: string | null;
};

/** Server-computed review status surfaced on the PR detail + merge box. */
export type ReviewSummary = {
  reviewers: ReviewerSummary[];
  approvals: number;
  changesRequested: number;
  commented: number;
  staleCount: number;
  unresolvedThreads: number;
};

/** A position a review comment is anchored to. */
export type ReviewCommentPosition =
  | { type: "text"; line: number; side: "base" | "incoming" }
  | { type: "gltf"; entityId: string };

/** One inline review comment (thread root when inReplyToId is null). */
export type ReviewComment = {
  id: string;
  reviewId: string;
  body: string;
  author: string;
  filePath: string;
  position: ReviewCommentPosition;
  inReplyToId: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** True while the comment belongs to the viewer's own unsubmitted (draft) review. */
  pending: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A submitted or pending pull-request review. */
export type Review = {
  id: string;
  state: "pending" | "approved" | "changes_requested" | "commented";
  body: string | null;
  author: string;
  submittedAt: string | null;
  commitSha: string | null;
  stale: boolean;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Enforced branch-protection rules (issue #85), as stored per branch. */
export type BranchProtectionRules = {
  requirePullRequest: boolean;
  requiredApprovals: number;
  requireGreenChecks: boolean;
  blockForcePush: boolean;
};

/** Protection status for a branch (settings page). */
export type BranchProtection = {
  branch: string;
  protected: boolean;
  rules: BranchProtectionRules;
};

/** One active merge-gate protection rule + whether it's satisfied. */
export type ProtectionRuleState = {
  key: "approvals" | "checks";
  label: string;
  satisfied: boolean;
  detail: string;
  /**
   * Informational caveat on a satisfied rule (e.g. green-checks passing
   * vacuously because no workflow has reported yet). Rendered as a muted info
   * line, never a blocker.
   */
  note?: string;
};

/** Server-computed branch-protection status surfaced on the merge box. */
export type ProtectionStatus = {
  branch: string;
  requiredApprovals: number;
  requireGreenChecks: boolean;
  approvals: number;
  changesRequested: number;
  checks: { total: number; passing: number; failing: number; pending: number } | null;
  rules: ProtectionRuleState[];
  blocked: boolean;
  reason: string | null;
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
  headSha?: string | null;
  reviewSummary?: ReviewSummary;
  protection?: ProtectionStatus | null;
  mergedAt: string | null;
  mergeMethod?: "merge" | "squash" | "rebase" | null;
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

/** The compact milestone reference embedded in issue / PR payloads (#83). */
export type MilestoneRef = {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
};

/** A milestone with its computed progress (closed vs total attached items). */
export type Milestone = MilestoneRef & {
  description: string | null;
  dueOn: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  openItems: number;
  closedItems: number;
  totalItems: number;
  percent: number;
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
  /** Time tracking (issue #122): whole minutes; 0 = unset. */
  estimateMinutes: number;
  spentMinutes: number;
  // Issue triage (#120) — optional so older list payloads still parse.
  pinnedAt?: string | null;
  locked?: boolean;
  lockReason?: string | null;
  // Milestone association (#83) — optional so older list payloads still parse.
  milestone?: MilestoneRef | null;
};

// ─── Projects: board + table over issues/PRs (issue #84) ─────────────────────

/** Which kind of subject a project item points at. */
export type ProjectSubjectType = "issue" | "pull";

/** A project row in the repo's project list (list-page card). */
export type ProjectSummary = {
  id: string;
  number: number;
  name: string;
  description: string | null;
  closed: boolean;
  itemCount: number;
  columnCount: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * The hydrated issue/PR a card represents. Null when the underlying issue/PR was
 * deleted after being added — the card degrades to a muted "unavailable" state.
 */
export type ProjectItemSubject = {
  type: ProjectSubjectType;
  number: number;
  title: string;
  /** issue: open|closed · pull: open|merged|closed */
  state: string;
  labels: Label[];
  assignee: string | null;
} | null;

/** One card on the board / one row in the table. */
export type ProjectItem = {
  id: string;
  columnId: string;
  position: number;
  subjectType: ProjectSubjectType;
  subjectNumber: number;
  subject: ProjectItemSubject;
  createdAt: string;
};

/** A status column and its ordered items. */
export type ProjectColumn = {
  id: string;
  name: string;
  position: number;
  items: ProjectItem[];
};

/** The full board: ordered columns, each with ordered hydrated items. */
export type ProjectDetail = {
  id: string;
  number: number;
  name: string;
  description: string | null;
  closed: boolean;
  columns: ProjectColumn[];
  createdAt: string;
  updatedAt: string;
};

/** A named, per-user snapshot of the issue-list filter bar (issue #120). */
export type SavedFilter = {
  id: string;
  name: string;
  query: string;
  scope: "issue" | "pull_request";
  createdAt: string;
};

export type IssueComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type ReleaseAsset = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  downloadCount: number;
  uploader: string | null;
  createdAt: string;
};

/** An append-only conversation event (labeled, closed, merged, referenced, …). */
export type TimelineEvent = {
  id: string;
  kind: string;
  actor: string;
  createdAt: string;
  /** Per-kind denormalized payload (label name/color, assignee, ref source, …). */
  data: Record<string, unknown>;
};

export type Release = {
  id: string;
  tagName: string;
  name: string;
  body: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  author: string;
  assets: ReleaseAsset[];
  createdAt: string;
  updatedAt: string;
};

export type Notification = {
  id: string;
  subjectType: "issue" | "pull_request" | "release";
  subjectId: string;
  subjectTitle: string;
  reason: "assigned" | "comment" | "review_requested" | "subscribed" | "mentioned";
  read: boolean;
  repo: string;
  updatedAt: string;
};

/** One slice of the format/domain composition bar. */
export type CompositionSegment = {
  /** Stable key for deterministic coloring: handler id, ".ext", or "other". */
  format: string;
  label: string;
  bytes: number;
  fileCount: number;
  pct: number;
  /** Semantic diffing is opted in for this format (`.forge/formats`). */
  optedIn: boolean;
};

export type Composition = {
  ref: string;
  sha: string | null;
  totalBytes: number;
  totalFiles: number;
  segments: CompositionSegment[];
};

export type SearchRepoResult = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerHandle: string;
  topics?: string[];
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

/** One matching source line inside a code-search result file. `line` is 1-based. */
export type CodeMatchLine = { line: number; preview: string };

/**
 * A code-search hit, grouped per file. `sha` is the canonical commit the ref
 * resolved to, so line links can deep-link to a permalink `#L` anchor that
 * never rots.
 */
export type SearchCodeResult = {
  repo: { ownerHandle: string; name: string };
  ref: string;
  sha: string;
  path: string;
  matches: CodeMatchLine[];
};

/** Envelope of a `type=code` search response. */
export type SearchCodeResponse = {
  type: "code";
  results: SearchCodeResult[];
  truncated: boolean;
  timedOut: boolean;
  reposSearched: number;
};

/**
 * An FHR entity hit — a structural match over ingested artifacts (e.g. a glTF
 * scene node), something byte-level code search structurally cannot surface.
 */
export type SearchEntityResult = {
  id: string;
  name: string;
  kind: string;
  path: string;
  repo: { ownerHandle: string; name: string };
  snapshot: {
    id: string;
    sourceFile: string;
    label: string | null;
    handlerId: string;
    gitCommitSha: string | null;
  };
};

// ─── Actions-style CI: workflow runs + check runs (issue #86) ────────────────────

export type CiStatus = "queued" | "running" | "completed";
export type CiConclusion = "success" | "failure" | "cancelled" | null;

/** Aggregate check counts for a commit — the /check-summary contract shape. */
export type CheckSummary = { total: number; passing: number; failing: number; pending: number };

/** Single-glyph rollup used by the status dots. */
export type CheckState = "success" | "failure" | "cancelled" | "pending" | "none";

export type CheckRun = {
  id: string;
  jobId: string;
  jobName: string;
  status: CiStatus;
  conclusion: CiConclusion;
  startedAt: string | null;
  completedAt: string | null;
  hasLog: boolean;
};

export type WorkflowRun = {
  id: string;
  commitSha: string;
  shortSha: string;
  trigger: "push" | "pull_request";
  ref: string | null;
  prId: string | null;
  workflowName: string;
  workflowPath: string;
  status: CiStatus;
  conclusion: CiConclusion;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Set when this run was created by re-running another run; points at its id. */
  rerunOfId: string | null;
  summary: CheckSummary;
  checkRuns: CheckRun[];
};

// ─── Contribution graph (issue #115) ──────────────────────────────────────────

/** One UTC day with a non-zero contribution count. */
export type ContributionDay = { date: string; count: number };

/**
 * A user's contribution activity over a window. `days` is sparse (only dates
 * with count > 0, ascending); the calendar heatmap fills the empty cells.
 */
export type Contributions = {
  days: ContributionDay[];
  total: number;
  from: string;
  to: string;
};
