/**
 * Shared review UI: verdict marks/labels (GitHub anatomy — green check for
 * approve, red for request-changes, grey speech bubble for comment), the inline
 * comment composer, and the collapsible resolved-aware review thread. Token-only
 * chrome; bodies render through MarkdownRenderer.
 */
import { useState } from "react";
import { Avatar, Badge, Button, RelativeTime, Textarea, cx } from "../../../ui";
import { MarkdownRenderer } from "../../../components/MarkdownRenderer";
import type { RepoRef } from "../../../lib/autolink";
import type { Review, ReviewComment, ReviewCommentPosition } from "../../../types";

/** The review mutation surface threaded down to the diff/thread widgets. */
export type ReviewInteraction = {
  currentUser: string;
  /** The viewer has an unsubmitted draft review in progress. */
  hasPendingReview: boolean;
  /** The viewer may open new inline comments (logged in, not the PR author, PR open). */
  canComment: boolean;
  /** Whether the viewer may resolve/unresolve a thread rooted by the given author. */
  canResolve: (rootAuthor: string) => boolean;
  busy: boolean;
  onCreate: (filePath: string, position: ReviewCommentPosition, body: string, mode: ComposeMode) => void;
  onReply: (rootId: string, body: string) => void;
  onToggleResolve: (rootId: string, resolved: boolean) => void;
};

type IconProps = { size?: number; className?: string };
function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0z" />
  </Svg>
);
export const XCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657zM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94z" />
  </Svg>
);
export const CommentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
  </Svg>
);
export const CheckMark = (p: IconProps) => (
  <Svg {...p}><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" /></Svg>
);

export type Verdict = "approved" | "changes_requested" | "commented";

const VERDICT_META: Record<Verdict, { Icon: (p: IconProps) => React.ReactElement; tone: string; verb: string }> = {
  approved: { Icon: CheckCircleIcon, tone: "text-fh-success-fg", verb: "approved these changes" },
  changes_requested: { Icon: XCircleIcon, tone: "text-fh-danger-fg", verb: "requested changes" },
  commented: { Icon: CommentIcon, tone: "text-fh-fg-muted", verb: "reviewed" },
};

/** The verdict glyph tinted in its semantic tone. */
export function ReviewVerdictIcon({ state, size = 16, className }: { state: Verdict; size?: number; className?: string }) {
  const meta = VERDICT_META[state];
  return <meta.Icon size={size} className={cx("shrink-0", meta.tone, className)} />;
}

export function reviewVerb(state: Verdict): string {
  return VERDICT_META[state].verb;
}

// ─── Inline comment composer ────────────────────────────────────────────────────

export type ComposeMode = "single" | "review";

export function InlineComposer({
  currentUser,
  hasPendingReview,
  busy,
  autoFocus,
  placeholder = "Leave a comment",
  submitLabelSingle = "Add single comment",
  onSubmit,
  onCancel,
}: {
  currentUser: string;
  hasPendingReview: boolean;
  busy?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  submitLabelSingle?: string;
  onSubmit: (body: string, mode: ComposeMode) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const trimmed = body.trim();

  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fh-border bg-fh-canvas text-fh-sm">
        <Avatar name={currentUser} size={20} />
        <span className="font-semibold text-fh-fg">{currentUser}</span>
      </div>
      <div className="p-2.5">
        <Textarea
          rows={3}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-end gap-2 flex-wrap">
          {onCancel && (
            <Button type="button" variant="default" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
          {hasPendingReview ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!trimmed}
              onClick={() => onSubmit(trimmed, "review")}
            >
              Add review comment
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="default"
                size="sm"
                loading={busy}
                disabled={!trimmed}
                onClick={() => onSubmit(trimmed, "single")}
              >
                {submitLabelSingle}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!trimmed}
                onClick={() => onSubmit(trimmed, "review")}
              >
                Start a review
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Review thread (root + replies, resolve-aware) ──────────────────────────────

export type ReviewThreadData = { root: ReviewComment; replies: ReviewComment[] };

function CommentCard({ comment, repo }: { comment: ReviewComment; repo: RepoRef }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2 text-fh-sm mb-1.5">
        <Avatar name={comment.author} size={20} />
        <span className="font-semibold text-fh-fg">{comment.author}</span>
        <span className="text-fh-fg-muted">commented <RelativeTime date={comment.createdAt} /></span>
        {comment.pending && <Badge tone="warning" pill={false}>Pending</Badge>}
      </div>
      <div className="pl-7 text-fh-sm">
        <MarkdownRenderer content={comment.body} repo={repo} />
      </div>
    </div>
  );
}

export function ReviewThread({
  thread,
  repo,
  currentUser,
  canResolve,
  busy,
  onReply,
  onToggleResolve,
  /** Compact framing for anchoring under a diff line. */
  anchored,
}: {
  thread: ReviewThreadData;
  repo: RepoRef;
  currentUser: string;
  canResolve: boolean;
  busy?: boolean;
  onReply: (rootId: string, body: string) => void;
  onToggleResolve: (rootId: string, resolved: boolean) => void;
  anchored?: boolean;
}) {
  const { root, replies } = thread;
  const [expanded, setExpanded] = useState(!root.resolved);
  const [replying, setReplying] = useState(false);

  const wrap = cx(
    "rounded-md border bg-fh-surface overflow-hidden",
    root.resolved ? "border-fh-border" : "border-fh-border",
    anchored && "my-1",
  );

  if (root.resolved && !expanded) {
    return (
      <div className={cx(wrap, "flex items-center gap-2 px-3 py-2 text-fh-sm")}>
        <span className="inline-flex items-center gap-1 text-fh-success-fg">
          <CheckMark size={14} />
        </span>
        <Badge tone="success" pill={false}>Resolved</Badge>
        <span className="text-fh-fg-muted truncate">
          {root.author}
          {root.resolvedBy ? <> · resolved by <span className="font-medium text-fh-fg">{root.resolvedBy}</span></> : null}
        </span>
        <button
          type="button"
          className="ml-auto text-fh-xs text-fh-accent-fg hover:underline bg-transparent border-none cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          Show
        </button>
      </div>
    );
  }

  return (
    <div className={wrap}>
      {root.resolved && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-fh-success-muted/40 border-b border-fh-border text-fh-xs">
          <Badge tone="success" pill={false}>Resolved</Badge>
          {root.resolvedBy && <span className="text-fh-fg-muted">by {root.resolvedBy}</span>}
          <button
            type="button"
            className="ml-auto text-fh-accent-fg hover:underline bg-transparent border-none cursor-pointer"
            onClick={() => setExpanded(false)}
          >
            Hide
          </button>
        </div>
      )}
      <div className="divide-y divide-fh-border">
        <CommentCard comment={root} repo={repo} />
        {replies.map((r) => <CommentCard key={r.id} comment={r} repo={repo} />)}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-fh-border bg-fh-canvas">
        {!replying && (
          <button
            type="button"
            className="text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg bg-transparent border-none cursor-pointer px-0"
            onClick={() => setReplying(true)}
          >
            Reply…
          </button>
        )}
        {canResolve && (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="ml-auto"
            loading={busy}
            onClick={() => onToggleResolve(root.id, !root.resolved)}
          >
            {root.resolved ? "Unresolve" : "Resolve"}
          </Button>
        )}
      </div>

      {replying && (
        <div className="px-3 pb-3">
          <ReplyBox
            currentUser={currentUser}
            busy={busy}
            onCancel={() => setReplying(false)}
            onSubmit={(body) => { onReply(root.id, body); setReplying(false); }}
          />
        </div>
      )}
    </div>
  );
}

function ReplyBox({
  currentUser,
  busy,
  onSubmit,
  onCancel,
}: {
  currentUser: string;
  busy?: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const trimmed = body.trim();
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fh-border bg-fh-canvas text-fh-xs">
        <Avatar name={currentUser} size={18} />
        <span className="font-semibold text-fh-fg">{currentUser}</span>
      </div>
      <div className="p-2">
        <Textarea rows={2} autoFocus placeholder="Reply…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="default" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="primary" size="sm" loading={busy} disabled={!trimmed} onClick={() => onSubmit(trimmed)}>
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Group a flat comment list into threads (root + replies), ordered by root time. */
export function groupThreads(comments: ReviewComment[]): ReviewThreadData[] {
  const roots = comments.filter((c) => c.inReplyToId == null);
  const byRoot = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (c.inReplyToId != null) {
      const arr = byRoot.get(c.inReplyToId) ?? [];
      arr.push(c);
      byRoot.set(c.inReplyToId, arr);
    }
  }
  return roots
    .map((root) => ({
      root,
      replies: (byRoot.get(root.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));
}

/**
 * The "finish your review" panel: an optional summary plus Comment / Approve /
 * Request changes. Submitting folds in any draft inline comments. The PR author
 * gets a note instead — they can still reply to and resolve threads.
 */
export function ReviewSubmitPanel({
  currentUser,
  isAuthor,
  pendingCount,
  hasPendingReview,
  busy,
  onSubmit,
  onDiscard,
}: {
  currentUser: string;
  isAuthor: boolean;
  pendingCount: number;
  hasPendingReview: boolean;
  busy: boolean;
  onSubmit: (state: Verdict, body: string) => void;
  onDiscard: () => void;
}) {
  const [body, setBody] = useState("");
  const [choice, setChoice] = useState<Verdict>("commented");

  if (isAuthor) {
    return (
      <div className="rounded-md border border-fh-border bg-fh-surface px-4 py-3 text-fh-sm text-fh-fg-muted">
        You can't submit a review on your own pull request. You can still reply to and resolve review threads.
      </div>
    );
  }

  const options: Array<{ value: Verdict; label: string; hint: string }> = [
    { value: "commented", label: "Comment", hint: "General feedback without explicit approval" },
    { value: "approved", label: "Approve", hint: "Submit feedback and approve merging" },
    { value: "changes_requested", label: "Request changes", hint: "Submit feedback that must be addressed before merging" },
  ];
  const active = options.find((o) => o.value === choice)!;

  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-fh-border bg-fh-canvas text-fh-sm">
        <Avatar name={currentUser} size={22} />
        <span className="font-semibold text-fh-fg">Finish your review</span>
        {pendingCount > 0 && (
          <Badge tone="warning" pill={false} className="ml-1">
            {pendingCount} pending comment{pendingCount === 1 ? "" : "s"}
          </Badge>
        )}
        {hasPendingReview && (
          <button
            type="button"
            className="ml-auto text-fh-xs text-fh-danger-fg hover:underline bg-transparent border-none cursor-pointer"
            disabled={busy}
            onClick={onDiscard}
          >
            Discard review
          </button>
        )}
      </div>
      <div className="p-3 space-y-3">
        <Textarea
          rows={3}
          placeholder="Leave a summary comment (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          {options.map((o) => (
            <label key={o.value} className="flex items-start gap-2 cursor-pointer text-fh-sm">
              <input
                type="radio"
                name="review-verdict"
                className="mt-1 accent-[var(--fh-accent-emphasis,currentColor)]"
                checked={choice === o.value}
                onChange={() => setChoice(o.value)}
              />
              <span className="min-w-0">
                <span className="inline-flex items-center gap-1.5 font-semibold text-fh-fg">
                  {o.value !== "commented" && <ReviewVerdictIcon state={o.value} size={14} />}
                  {o.label}
                </span>
                <span className="block text-fh-xs text-fh-fg-subtle">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant={choice === "changes_requested" ? "danger" : "primary"}
            size="sm"
            loading={busy}
            onClick={() => onSubmit(choice, body.trim())}
          >
            Submit {active.label.toLowerCase()}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A vertical list of review threads (used under semantic/binary file cards). */
export function FileThreadList({
  threads,
  repo,
  review,
}: {
  threads: ReviewThreadData[];
  repo: RepoRef;
  review: ReviewInteraction;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="space-y-2">
      {threads.map((t) => (
        <ReviewThread
          key={t.root.id}
          thread={t}
          repo={repo}
          currentUser={review.currentUser}
          canResolve={review.canResolve(t.root.author)}
          busy={review.busy}
          onReply={review.onReply}
          onToggleResolve={review.onToggleResolve}
          anchored
        />
      ))}
    </div>
  );
}

/** A submitted review, rendered as a conversation card. */
export function ReviewCard({ review, repo }: { review: Review; repo: RepoRef }) {
  if (review.state === "pending") return null;
  const verdict = review.state as Verdict;
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas text-fh-sm">
        <span className={cx("flex items-center justify-center shrink-0", VERDICT_META[verdict].tone)}>
          <ReviewVerdictIcon state={verdict} size={18} />
        </span>
        <Avatar name={review.author} size={22} />
        <span className="min-w-0">
          <span className="font-semibold text-fh-fg">{review.author}</span>{" "}
          <span className="text-fh-fg-muted">{reviewVerb(verdict)}</span>{" "}
          <RelativeTime date={review.submittedAt ?? review.createdAt} className="text-fh-fg-subtle" />
        </span>
        {review.stale && <Badge tone="neutral" pill={false} className="ml-1">Stale</Badge>}
        {review.commentCount > 0 && (
          <span className="ml-auto text-fh-xs text-fh-fg-subtle">
            {review.commentCount} inline comment{review.commentCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {review.body && (
        <div className="px-5 py-3 text-fh-sm">
          <MarkdownRenderer content={review.body} repo={repo} />
        </div>
      )}
    </div>
  );
}
