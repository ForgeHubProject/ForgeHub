import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createPullComment, createReview, createReviewComment, deleteReview, getPull,
  listPRCommits, listPRFiles, listPullComments, listPullTimeline, listReviewComments,
  listReviews, replyToReviewThread, setReviewThreadResolved, submitReview,
} from "../../../api";
import { MarkdownRenderer } from "../../../components/MarkdownRenderer";
import { TimelineEventRow } from "../../../components/TimelineEventRow";
import type {
  CommitInfo, IssueComment, PRFileEntry, PullRequest, Review, ReviewComment,
  ReviewCommentPosition, TimelineEvent, User,
} from "../../../types";
import { Avatar, Button, RelativeTime, Skeleton, TabItem, TabNav, Textarea } from "../../../ui";
import { MergeBox } from "./MergeBox";
import { PRChecks } from "./PRChecks";
import { PRFileRow } from "./PRFileRow";
import {
  ReviewCard,
  ReviewSubmitPanel,
  ReviewVerdictIcon,
  type ComposeMode,
  type ReviewInteraction,
  type Verdict,
} from "./reviewShared";
import {
  ArrowLeftIcon,
  BranchChip,
  FileDiffIcon,
  GitCommitIcon,
  StatePill,
} from "./prShared";

type TabKey = "commits" | "files";

export function PullDetail({
  token,
  handle,
  repoName,
  number,
  user,
}: {
  token: string;
  handle: string;
  repoName: string;
  number: number;
  user: User;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const repoRef = { owner: handle, name: repoName };

  const [pr, setPr] = useState<PullRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("commits");

  const [comments, setComments] = useState<IssueComment[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);

  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [prFiles, setPrFiles] = useState<PRFileEntry[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPull(token, handle, repoName, number)
      .then(setPr)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  useEffect(() => {
    Promise.all([
      listPullComments(token, handle, repoName, number).catch(() => ({ comments: [] })),
      listPullTimeline(token, handle, repoName, number).catch(() => ({ events: [] })),
    ]).then(([c, tl]) => {
      setComments(c.comments);
      setEvents(tl.events);
    });
  }, [token, handle, repoName, number]);

  const refreshReviews = useCallback(() => {
    Promise.all([
      listReviews(token, handle, repoName, number).catch(() => ({ reviews: [] as Review[] })),
      listReviewComments(token, handle, repoName, number).catch(() => ({ comments: [] as ReviewComment[] })),
    ]).then(([r, c]) => {
      setReviews(r.reviews);
      setReviewComments(c.comments);
    });
  }, [token, handle, repoName, number]);

  useEffect(() => { refreshReviews(); }, [refreshReviews]);

  const refreshPr = useCallback(() => {
    getPull(token, handle, repoName, number)
      .then(setPr)
      .catch(() => { /* keep prior PR on failure */ });
  }, [token, handle, repoName, number]);

  function refreshTimeline() {
    listPullTimeline(token, handle, repoName, number)
      .then((tl) => setEvents(tl.events))
      .catch(() => { /* keep prior events on failure */ });
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmitting(true);
    try {
      const c = await createPullComment(token, handle, repoName, number, commentBody.trim());
      setComments((prev) => [...prev, c]);
      setCommentBody("");
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to comment");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (activeTab !== "commits" || commits !== null || !pr) return;
    setCommitsLoading(true);
    listPRCommits(token, handle, repoName, number)
      .then((d) => setCommits(d.commits))
      .catch(() => setCommits([]))
      .finally(() => setCommitsLoading(false));
  }, [activeTab, commits, pr, token, handle, repoName, number]);

  useEffect(() => {
    if (activeTab !== "files" || prFiles !== null || !pr) return;
    setFilesLoading(true);
    listPRFiles(token, handle, repoName, number)
      .then((d) => setPrFiles(d.files))
      .catch(() => setPrFiles([]))
      .finally(() => setFilesLoading(false));
  }, [activeTab, prFiles, pr, token, handle, repoName, number]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4 rounded" />
        <Skeleton className="h-6 w-1/3 rounded" />
        <div className="rounded-md border border-fh-border bg-fh-surface p-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="text" width={`${80 - i * 12}%`} />
          ))}
        </div>
      </div>
    );
  }

  if (error && !pr) {
    return (
      <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-12 text-center">
        <p className="text-fh-base text-fh-danger-fg">{error}</p>
        <div className="mt-4 flex justify-center">
          <Button variant="default" leadingIcon={<ArrowLeftIcon size={14} />} onClick={() => navigate(`${base}/pulls`)}>
            Back to pull requests
          </Button>
        </div>
      </div>
    );
  }

  if (!pr) return null;

  const totalAdditions = prFiles?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = prFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  // ── Review derived state ──────────────────────────────────────────────────────
  const isAuthor = pr.author === user.handle;
  const isOwner = user.handle === handle; // repo owner handle == route handle
  const pendingReview = reviews.find((r) => r.state === "pending" && r.author === user.handle) ?? null;
  const hasPendingReview = pendingReview != null;
  const pendingCount = reviewComments.filter((c) => c.pending).length;
  const submittedReviews = reviews.filter((r) => r.state !== "pending" && r.submittedAt);
  const canComment = !isAuthor && pr.state === "open";

  async function onCreateReviewComment(
    filePath: string,
    position: ReviewCommentPosition,
    body: string,
    mode: ComposeMode,
  ) {
    setReviewBusy(true);
    setError(null);
    try {
      const c = await createReviewComment(token, handle, repoName, number, { body, filePath, position });
      // "Add single comment" submits a one-comment COMMENTED review immediately.
      if (mode === "single") await submitReview(token, handle, repoName, number, c.reviewId, { state: "commented" });
      refreshReviews();
      refreshPr();
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setReviewBusy(false);
    }
  }

  async function onReplyThread(rootId: string, body: string) {
    setReviewBusy(true);
    setError(null);
    try {
      await replyToReviewThread(token, handle, repoName, number, rootId, body);
      refreshReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reply");
    } finally {
      setReviewBusy(false);
    }
  }

  async function onToggleResolve(rootId: string, resolved: boolean) {
    setReviewBusy(true);
    setError(null);
    try {
      await setReviewThreadResolved(token, handle, repoName, number, rootId, resolved);
      refreshReviews();
      refreshPr();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update thread");
    } finally {
      setReviewBusy(false);
    }
  }

  async function onSubmitReview(state: Verdict, body: string) {
    setReviewBusy(true);
    setError(null);
    try {
      if (pendingReview) {
        await submitReview(token, handle, repoName, number, pendingReview.id, { state, body: body || undefined });
      } else {
        await createReview(token, handle, repoName, number, { state, body: body || undefined });
      }
      refreshReviews();
      refreshPr();
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setReviewBusy(false);
    }
  }

  async function onDiscardReview() {
    if (!pendingReview) return;
    setReviewBusy(true);
    setError(null);
    try {
      await deleteReview(token, handle, repoName, number, pendingReview.id);
      refreshReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discard review");
    } finally {
      setReviewBusy(false);
    }
  }

  const reviewInteraction: ReviewInteraction = {
    currentUser: user.handle,
    hasPendingReview,
    canComment,
    canResolve: (author) => isOwner || author === user.handle,
    busy: reviewBusy,
    onCreate: onCreateReviewComment,
    onReply: onReplyThread,
    onToggleResolve,
  };

  // Comments, non-comment events, and submitted reviews, interleaved chronologically.
  const stream = [
    ...comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, comment: c })),
    ...events.map((ev) => ({ kind: "event" as const, at: ev.createdAt, event: ev })),
    ...submittedReviews.map((rv) => ({ kind: "review" as const, at: rv.submittedAt ?? rv.createdAt, review: rv })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return (
    <div>
      <Link
        to={`${base}/pulls`}
        className="inline-flex items-center gap-1.5 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-4 no-underline"
      >
        <ArrowLeftIcon size={14} />
        Pull requests
      </Link>

      {/* Title */}
      <h1 className="text-fh-2xl font-semibold text-fh-fg leading-tight mb-3">
        {pr.title} <span className="text-fh-fg-subtle font-normal">#{pr.number}</span>
      </h1>

      {/* Status line */}
      <div className="flex items-center gap-3 flex-wrap pb-4 mb-5 border-b border-fh-border">
        <StatePill state={pr.state} />
        <p className="text-fh-sm text-fh-fg-muted inline-flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-fh-fg">{pr.author}</span>
          <span>wants to merge into</span>
          <BranchChip name={pr.toBranch} />
          <span>from</span>
          <BranchChip name={pr.fromBranch} />
          <span className="text-fh-fg-subtle">·</span>
          <RelativeTime date={pr.createdAt} />
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Main column */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Opening comment */}
          <div className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas">
              <Avatar name={pr.author} size={24} />
              <span className="text-fh-sm">
                <span className="font-semibold text-fh-fg">{pr.author}</span>{" "}
                <span className="text-fh-fg-muted">
                  opened <RelativeTime date={pr.createdAt} />
                </span>
              </span>
            </div>
            <div className="px-5 py-4">
              {pr.description ? (
                <MarkdownRenderer content={pr.description} repo={repoRef} />
              ) : (
                <p className="text-fh-sm text-fh-fg-subtle italic">No description provided.</p>
              )}
            </div>
          </div>

          {/* Conversation: comments, submitted reviews, and timeline events */}
          {stream.map((item) =>
            item.kind === "comment" ? (
              <div key={`c-${item.comment.id}`} className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
                <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas text-fh-sm">
                  <Avatar name={item.comment.author} size={22} />
                  <span className="font-semibold text-fh-fg">{item.comment.author}</span>
                  <span className="text-fh-fg-muted">commented <RelativeTime date={item.comment.createdAt} /></span>
                </div>
                <div className="px-5 py-4">
                  <MarkdownRenderer content={item.comment.body} repo={repoRef} />
                </div>
              </div>
            ) : item.kind === "review" ? (
              <ReviewCard key={`r-${item.review.id}`} review={item.review} repo={repoRef} />
            ) : (
              // `reviewed` timeline events are intentionally rendered by ReviewCard
              // above (from the reviews feed), so TimelineEventRow no-ops on them.
              <TimelineEventRow key={`e-${item.event.id}`} event={item.event} repo={repoRef} />
            ),
          )}

          {/* Comment composer */}
          <form onSubmit={submitComment} className="rounded-md border border-fh-border bg-fh-surface overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-fh-border bg-fh-canvas text-fh-sm">
              <Avatar name={user.displayName ?? user.handle} size={22} />
              <span className="font-semibold text-fh-fg">Add a comment</span>
            </div>
            <div className="p-3">
              <Textarea
                rows={4}
                placeholder="Leave a comment"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              <p className="mt-1.5 text-fh-xs text-fh-fg-subtle">Styling with Markdown is supported.</p>
              <div className="flex items-center justify-end mt-3">
                <Button type="submit" variant="primary" loading={submitting} disabled={!commentBody.trim()}>
                  Comment
                </Button>
              </div>
            </div>
          </form>

          {/* Tabs */}
          <TabNav aria-label="Pull request">
            <TabItem
              active={activeTab === "commits"}
              icon={<GitCommitIcon size={15} />}
              count={commits?.length}
              onClick={() => setActiveTab("commits")}
            >
              Commits
            </TabItem>
            <TabItem
              active={activeTab === "files"}
              icon={<FileDiffIcon size={15} />}
              count={prFiles?.length}
              onClick={() => setActiveTab("files")}
            >
              Files changed
            </TabItem>
          </TabNav>

          {/* Commits tab */}
          {activeTab === "commits" &&
            (commitsLoading ? (
              <div className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <Skeleton variant="circle" width={20} height={20} />
                    <Skeleton className="flex-1 h-4 rounded" />
                    <Skeleton width={56} height={20} className="rounded" />
                  </div>
                ))}
              </div>
            ) : commits && commits.length === 0 ? (
              <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-10 text-center text-fh-sm text-fh-fg-muted">
                No commits found between these branches.
              </div>
            ) : commits ? (
              <ul className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
                {commits.map((c) => (
                  <li
                    key={c.sha}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-fh-surface-muted/60 transition-colors"
                  >
                    <Avatar name={c.authorName} size={20} />
                    <span className="flex-1 min-w-0 truncate text-fh-sm text-fh-fg">{c.subject}</span>
                    <button
                      type="button"
                      className="font-mono text-fh-xs text-fh-fg-muted bg-fh-surface-muted border border-fh-border px-1.5 py-0.5 rounded hover:border-fh-border-strong hover:text-fh-accent-fg transition-colors shrink-0"
                      onClick={() => navigate(`${base}/commits/${c.sha}`)}
                    >
                      {c.shortSha}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null)}

          {/* Files tab */}
          {activeTab === "files" &&
            (filesLoading ? (
              <div className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <Skeleton width={12} height={12} className="rounded" />
                    <Skeleton className="flex-1 h-4 rounded" />
                    <Skeleton width={48} height={16} className="rounded" />
                  </div>
                ))}
              </div>
            ) : prFiles && prFiles.length === 0 ? (
              <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-10 text-center text-fh-sm text-fh-fg-muted">
                No files changed.
              </div>
            ) : prFiles ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-fh-sm text-fh-fg-muted">
                    Showing <span className="font-semibold text-fh-fg">{prFiles.length}</span> changed file
                    {prFiles.length !== 1 ? "s" : ""} with{" "}
                    <span className="font-mono font-semibold text-fh-success-fg">+{totalAdditions}</span>{" "}
                    <span className="font-mono font-semibold text-fh-danger-fg">−{totalDeletions}</span>
                  </p>
                  {canComment && (
                    <span className="text-fh-xs text-fh-fg-subtle ml-auto">
                      Hover a line and click <span className="font-semibold text-fh-accent-fg">+</span> to comment
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {prFiles.map((file) => (
                    <PRFileRow
                      key={file.path}
                      token={token}
                      handle={handle}
                      repoName={repoName}
                      prNumber={number}
                      file={file}
                      base={base}
                      headRef={pr.fromBranch}
                      repoRef={repoRef}
                      comments={reviewComments}
                      review={reviewInteraction}
                    />
                  ))}
                </div>
              </div>
            ) : null)}

          {/* Finish-your-review panel (open PRs) */}
          {pr.state === "open" && (
            <ReviewSubmitPanel
              currentUser={user.handle}
              isAuthor={isAuthor}
              pendingCount={pendingCount}
              hasPendingReview={hasPendingReview}
              busy={reviewBusy}
              onSubmit={onSubmitReview}
              onDiscard={onDiscardReview}
            />
          )}

          {/* CI checks for the PR head (issue #86) — above the merge box */}
          <PRChecks token={token} handle={handle} repoName={repoName} pr={pr} base={base} />

          {/* Merge box */}
          <MergeBox token={token} handle={handle} repoName={repoName} pr={pr} onUpdate={(p) => { setPr(p); refreshTimeline(); refreshReviews(); }} />
        </div>

        {/* Sidebar */}
        <aside className="w-full lg:w-56 shrink-0 text-fh-sm">
          <div className="border-b border-fh-border pb-3 mb-3">
            <p className="font-semibold text-fh-fg mb-1.5">Reviewers</p>
            {pr.reviewSummary && pr.reviewSummary.reviewers.length > 0 ? (
              <ul className="space-y-1.5">
                {pr.reviewSummary.reviewers.map((rv) => (
                  <li key={rv.author} className="flex items-center gap-1.5">
                    <Avatar name={rv.author} size={18} />
                    <Link to={`/${rv.author}`} className="text-fh-sm text-fh-fg hover:text-fh-accent-fg truncate no-underline">
                      {rv.author}
                    </Link>
                    <span className="ml-auto inline-flex items-center gap-1">
                      {rv.stale && <span className="text-fh-xs text-fh-fg-subtle">stale</span>}
                      <ReviewVerdictIcon state={rv.state} size={14} className={rv.stale ? "opacity-40" : undefined} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fh-xs text-fh-fg-subtle">No reviews yet.</p>
            )}
          </div>
          <div>
            <p className="font-semibold text-fh-fg mb-1.5">Labels</p>
            <p className="text-fh-xs text-fh-fg-subtle">No labels yet.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
