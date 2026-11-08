import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError, applySuggestion, createPullComment, createReview, createReviewComment, deleteComment, deleteReview, getIssue, getPull,
  listPRCommits, listPRFiles, listPullComments, listPullTimeline, listReviewComments,
  listReviews, listWorkflowRuns, replyToReviewThread, setPRFileViewed, setReviewThreadResolved, submitReview, updateComment, updatePull,
} from "../../../api";
import { CommentMenu, EditableBody, quoteReply } from "../../../components/CommentActions";
import { MarkdownEditor } from "../../../components/MarkdownEditor";
import { ReactionBar } from "../../../components/ReactionBar";
import { TimelineEventRow } from "../../../components/TimelineEventRow";
import type {
  CommitInfo, IssueComment, PRFileEntry, PullRequest, Review, ReviewComment,
  ReviewCommentPosition, TimelineEvent, User,
} from "../../../types";
import { Avatar, Button, ConfirmDialog, EmptyState, RelativeTime, Skeleton, TabItem, TabNav, TextInput, cx, useToast } from "../../../ui";
import { SignatureBadge } from "../commitUi";
import { CommentIcon } from "../issues/icons";
import { Popover } from "../issues/pickers";
import { MergeBox } from "./MergeBox";
import { PRChecks } from "./PRChecks";
import { PRFileRow } from "./PRFileRow";
import { PRFileTree } from "./PRFileTree";
import { PullSidebar } from "./PullSidebar";
import {
  ReviewCard,
  ReviewSubmitPanel,
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
import { useRepoPermission } from "../permission";

/** The page's tabs, GitHub's (#252): each is its own URL under `pulls/:number`. */
export type TabKey = "conversation" | "commits" | "checks" | "files";

export function PullDetail({
  token,
  handle,
  repoName,
  number,
  tab: activeTab,
  user,
}: {
  token: string;
  handle: string;
  repoName: string;
  number: number;
  /** The tab, from the URL: `pulls/:number`, `/commits`, `/checks` or `/files`. */
  tab: TabKey;
  user: User;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const repoRef = { owner: handle, name: repoName };

  const [pr, setPr] = useState<PullRequest | null>(null);
  const { canWrite, canAdmin } = useRepoPermission();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [comments, setComments] = useState<IssueComment[]>([]);
  // Editing (#253): "body" for the description, else a comment id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingComment, setDeletingComment] = useState<IssueComment | null>(null);
  const { toast } = useToast();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);

  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [prFiles, setPrFiles] = useState<PRFileEntry[] | null>(null);
  // The commit those files are diffed against; their semantic diffs use it too.
  const [prMergeBase, setPrMergeBase] = useState<string | null>(null);
  // The head they are at. Once merged or closed the branch may have moved or
  // gone, so the files are read at this commit, not at the branch's name.
  const [prHead, setPrHead] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  // Check runs on the head, for the Checks tab's count.
  const [checkCount, setCheckCount] = useState<number | undefined>(undefined);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPull(token, handle, repoName, number)
      .then(setPr)
      .catch(async (e) => {
        // One sequence for issues and pull requests (#259): N may be an issue.
        if (e instanceof ApiError && e.status === 404) {
          const issue = await getIssue(token, handle, repoName, number).catch(() => null);
          if (issue) return navigate(`${base}/issues/${number}`, { replace: true });
        }
        setError(e instanceof Error ? e.message : "Not found");
      })
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

  /** Quote reply (#253): quote into the comment box and go there. */
  function quote(text: string) {
    setCommentBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n` : "") + quoteReply(text));
    const box = document.getElementById("new-comment");
    box?.scrollIntoView({ block: "center" });
    box?.focus();
  }

  async function removeComment() {
    if (!deletingComment) return;
    try {
      await deleteComment(token, handle, repoName, "pulls", number, deletingComment.id);
      setComments((prev) => prev.filter((c) => c.id !== deletingComment.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't delete the comment", { tone: "danger" });
    } finally {
      setDeletingComment(null);
    }
  }

  async function submitComment(e?: React.FormEvent) {
    e?.preventDefault();
    if (!commentBody.trim() || submitting) return;
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

  // Commits and files load with the page, not with their tabs: the tab bar
  // shows their counts, and the header says how many commits merge.
  useEffect(() => {
    if (commits !== null || !pr) return;
    setCommitsLoading(true);
    listPRCommits(token, handle, repoName, number)
      .then((d) => setCommits(d.commits))
      .catch(() => setCommits([]))
      .finally(() => setCommitsLoading(false));
  }, [commits, pr, token, handle, repoName, number]);

  const headSha = pr?.headSha ?? null;
  useEffect(() => {
    if (!headSha) return;
    listWorkflowRuns(token, handle, repoName, { sha: headSha })
      .then(({ runs }) => setCheckCount(runs.reduce((n, r) => n + r.summary.total, 0)))
      .catch(() => setCheckCount(undefined));
  }, [headSha, token, handle, repoName]);

  // The Files changed toolbar (#252), kept in the URL as GitHub does:
  // ?commit= (one of the PR's commits), ?diff=split, ?w=1 (hide whitespace).
  const [params, setParams] = useSearchParams();
  const commitSha = params.get("commit");
  const diffView: "unified" | "split" = params.get("diff") === "split" ? "split" : "unified";
  const hideWhitespace = params.get("w") === "1";
  const [fileFilter, setFileFilter] = useState("");
  function setOption(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }
  // Choosing a commit (or going back to all of them) is another file list.
  const filesFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (filesFor.current !== undefined && filesFor.current !== commitSha) setPrFiles(null);
    filesFor.current = commitSha;
  }, [commitSha]);

  useEffect(() => {
    if (prFiles !== null || !pr) return;
    setFilesLoading(true);
    listPRFiles(token, handle, repoName, number, commitSha)
      .then((d) => {
        setPrFiles(d.files);
        setPrMergeBase(d.mergeBaseSha ?? null);
        setPrHead(d.headSha ?? null);
      })
      .catch(() => setPrFiles([]))
      .finally(() => setFilesLoading(false));
  }, [prFiles, pr, token, handle, repoName, number, commitSha]);

  async function saveTitle(e: React.FormEvent) {
    e.preventDefault();
    if (!pr || !titleDraft.trim()) return;
    setSavingTitle(true);
    try {
      const updated = await updatePull(token, handle, repoName, number, { title: titleDraft.trim() });
      setPr((prev) => (prev ? { ...prev, title: updated.title } : prev));
      setEditingTitle(false);
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setSavingTitle(false);
    }
  }

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

  const shownFiles = (prFiles ?? []).filter((f) => !fileFilter.trim() || f.path.toLowerCase().includes(fileFilter.trim().toLowerCase()));
  const totalAdditions = prFiles?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = prFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  // ── Review derived state ──────────────────────────────────────────────────────
  const isAuthor = pr.author === user.handle;
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
    suggestion?: string,
  ) {
    setReviewBusy(true);
    setError(null);
    try {
      const c = await createReviewComment(token, handle, repoName, number, { body, filePath, position, suggestion });
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

  /** Apply a suggested change (issue #119): commits to the head branch, so the diff + head SHA move. */
  async function onApplySuggestion(commentId: string) {
    setReviewBusy(true);
    setError(null);
    try {
      await applySuggestion(token, handle, repoName, number, commentId);
      refreshReviews();
      refreshPr();
      refreshTimeline();
      // The head moved: re-fetch files so diffs, stats, and viewed ticks are honest.
      setPrFiles(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply suggestion");
    } finally {
      setReviewBusy(false);
    }
  }

  /** Optimistically tick/untick a file's Viewed state (issue #119). */
  async function onToggleViewed(path: string, viewed: boolean) {
    setPrFiles((prev) => prev?.map((f) => (f.path === path ? { ...f, viewed } : f)) ?? prev);
    try {
      await setPRFileViewed(token, handle, repoName, number, path, viewed);
    } catch {
      // Roll the optimistic flip back on failure.
      setPrFiles((prev) => prev?.map((f) => (f.path === path ? { ...f, viewed: !viewed } : f)) ?? prev);
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
    // Enables reaction pills on review-thread comments (#90).
    reactionCtx: { token, handle, repoName },
    hasPendingReview,
    canComment,
    // The API's rules (#218): a writer or the thread's author resolves it;
    // applying a suggestion pushes to the branch, so it needs write access.
    canResolve: (author) => canWrite || author === user.handle,
    // Applying writes to the head branch. The server enforces the real writer
    // gate; the UI offers the action to the owner and the PR author (the usual
    // appliers) rather than advertising it to every signed-in visitor.
    canApplySuggestion: pr.state === "open" && canWrite,
    busy: reviewBusy,
    onCreate: onCreateReviewComment,
    onReply: onReplyThread,
    onToggleResolve,
    onApplySuggestion,
  };

  // Comments, non-comment events, and submitted reviews, interleaved chronologically.
  const stream = [
    ...comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, comment: c })),
    ...events.map((ev) => ({ kind: "event" as const, at: ev.createdAt, event: ev })),
    ...submittedReviews.map((rv) => ({ kind: "review" as const, at: rv.submittedAt ?? rv.createdAt, review: rv })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Everyone who took part, author first: the sidebar's Participants.
  const participants = [
    ...new Set([
      pr.author,
      ...comments.map((c) => c.author),
      ...reviews.filter((r) => r.state !== "pending").map((r) => r.author),
      ...reviewComments.filter((c) => !c.pending).map((c) => c.author),
    ]),
  ];

  const canEditTitle = isAuthor || canWrite;
  const commitWord = commits ? `${commits.length} ${commits.length === 1 ? "commit" : "commits"}` : "";
  const tabUrl = (t: TabKey) => `${base}/pulls/${number}${t === "conversation" ? "" : `/${t}`}`;

  return (
    <div>
      <Link
        to={`${base}/pulls`}
        className="inline-flex items-center gap-1.5 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-4 no-underline"
      >
        <ArrowLeftIcon size={14} />
        Pull requests
      </Link>

      {/* Title, with Edit and Code beside it, as on GitHub */}
      {editingTitle ? (
        <form onSubmit={saveTitle} className="flex items-center gap-2 mb-3">
          <TextInput
            aria-label="Title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            className="flex-1 text-fh-lg"
            autoFocus
          />
          <Button type="submit" loading={savingTitle} disabled={!titleDraft.trim()}>Save</Button>
          <Button type="button" variant="invisible" onClick={() => setEditingTitle(false)}>Cancel</Button>
        </form>
      ) : (
        <div className="flex items-start gap-3 mb-3">
          <h1 className="flex-1 min-w-0 text-fh-2xl font-semibold text-fh-fg leading-tight break-words">
            {pr.title} <span className="text-fh-fg-subtle font-normal">#{pr.number}</span>
          </h1>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            {canEditTitle && (
              <Button size="sm" onClick={() => { setTitleDraft(pr.title); setEditingTitle(true); }}>Edit</Button>
            )}
            <CheckoutMenu fromBranch={pr.fromBranch} number={pr.number} />
          </div>
        </div>
      )}

      {/* Status line */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <StatePill state={pr.state} draft={pr.isDraft} />
        <p className="text-fh-sm text-fh-fg-muted inline-flex items-center gap-1.5 flex-wrap">
          <Link to={`/${pr.author}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{pr.author}</Link>
          <span>
            {pr.state === "merged" ? "merged" : "wants to merge"}
            {commitWord && ` ${commitWord}`} into
          </span>
          <BranchChip name={pr.toBranch} />
          <span>from</span>
          <BranchChip name={pr.fromBranch} />
          <span className="text-fh-fg-subtle">·</span>
          <RelativeTime date={pr.state === "merged" && pr.mergedAt ? pr.mergedAt : pr.createdAt} />
        </p>
      </div>

      {/* Tabs, GitHub's four, with the diff's size at the end */}
      <TabNav aria-label="Pull request" className="mb-5">
        <TabItem active={activeTab === "conversation"} icon={<CommentIcon size={15} />} count={comments.length} to={tabUrl("conversation")}>
          Conversation
        </TabItem>
        <TabItem active={activeTab === "commits"} icon={<GitCommitIcon size={15} />} count={commits?.length} to={tabUrl("commits")}>
          Commits
        </TabItem>
        <TabItem active={activeTab === "checks"} icon={<ChecksIcon size={15} />} count={checkCount} to={tabUrl("checks")}>
          Checks
        </TabItem>
        <TabItem active={activeTab === "files"} icon={<FileDiffIcon size={15} />} count={prFiles?.length} to={tabUrl("files")}>
          Files changed
        </TabItem>
        {prFiles && (
          <span className="ml-auto self-center pl-3 font-mono text-fh-xs whitespace-nowrap">
            <span className="font-semibold text-fh-success-fg">+{totalAdditions}</span>{" "}
            <span className="font-semibold text-fh-danger-fg">−{totalDeletions}</span>
          </span>
        )}
      </TabNav>

      {activeTab === "conversation" && (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 min-w-0 space-y-4">
            {/* Opening comment */}
            <div id="pr-body" className="rounded-md border border-fh-border bg-fh-surface overflow-hidden scroll-mt-20">
              <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas">
                <Avatar name={pr.author} size={24} />
                <span className="text-fh-sm">
                  <span className="font-semibold text-fh-fg">{pr.author}</span>{" "}
                  <span className="text-fh-fg-muted">
                    opened <RelativeTime date={pr.createdAt} />
                  </span>
                </span>
                <CommentMenu
                  anchor="pr-body"
                  onQuote={pr.description ? () => quote(pr.description!) : undefined}
                  onEdit={isAuthor || canWrite ? () => setEditingId("body") : undefined}
                />
              </div>
              <div className="px-5 py-4">
                <EditableBody
                  token={token}
                  repo={repoRef}
                  body={pr.description}
                  editing={editingId === "body"}
                  onCancel={() => setEditingId(null)}
                  onSave={async (description) => {
                    const updated = await updatePull(token, handle, repoName, number, { description });
                    setPr((prev) => (prev ? { ...prev, description: updated.description } : prev));
                    setEditingId(null);
                  }}
                  empty="No description provided."
                />
                {/* Emoji reactions on the PR body (#90). */}
                <ReactionBar
                  token={token}
                  handle={handle}
                  repoName={repoName}
                  subjectType="pull_request"
                  subjectId={pr.id}
                  reactions={pr.reactions}
                  viewerReacted={pr.viewerReacted}
                  className="mt-3"
                />
              </div>
            </div>

            {/* Conversation: comments, submitted reviews, and timeline events */}
            {stream.map((item) =>
              item.kind === "comment" ? (
                <div key={`c-${item.comment.id}`} id={`issuecomment-${item.comment.id}`} className="rounded-md border border-fh-border bg-fh-surface overflow-hidden scroll-mt-20">
                  <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-fh-border bg-fh-canvas text-fh-sm">
                    <Avatar name={item.comment.author} size={22} />
                    <span className="font-semibold text-fh-fg">{item.comment.author}</span>
                    <span className="text-fh-fg-muted">commented <RelativeTime date={item.comment.createdAt} /></span>
                    <CommentMenu
                      anchor={`issuecomment-${item.comment.id}`}
                      onQuote={() => quote(item.comment.body)}
                      onEdit={item.comment.author === user.handle ? () => setEditingId(item.comment.id) : undefined}
                      onDelete={item.comment.author === user.handle || canAdmin ? () => setDeletingComment(item.comment) : undefined}
                    />
                  </div>
                  <div className="px-5 py-4">
                    <EditableBody
                      token={token}
                      repo={repoRef}
                      body={item.comment.body}
                      editing={editingId === item.comment.id}
                      onCancel={() => setEditingId(null)}
                      onSave={async (body) => {
                        const updated = await updateComment(token, handle, repoName, "pulls", number, item.comment.id, body);
                        setComments((prev) => prev.map((c) => (c.id === updated.id ? { ...c, body: updated.body } : c)));
                        setEditingId(null);
                      }}
                    />
                    <ReactionBar
                      token={token}
                      handle={handle}
                      repoName={repoName}
                      subjectType="pr_comment"
                      subjectId={item.comment.id}
                      reactions={item.comment.reactions}
                      viewerReacted={item.comment.viewerReacted}
                      className="mt-3"
                    />
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

            {/* CI checks for the PR head (issue #86) — above the merge box */}
            <PRChecks token={token} handle={handle} repoName={repoName} pr={pr} base={base} />

            {/* Merge box */}
            <MergeBox token={token} handle={handle} repoName={repoName} pr={pr} canMarkReady={isAuthor || canAdmin} canClose={isAuthor || canAdmin} onUpdate={(p) => { setPr(p); refreshTimeline(); refreshReviews(); }} />

            {/* Comment composer, last, as on GitHub */}
            <form onSubmit={submitComment} className="flex gap-3 pt-4 border-t border-fh-border">
              <Avatar name={user.displayName ?? user.handle} size={32} className="hidden sm:inline-flex mt-7" />
              <div className="flex-1 min-w-0">
                <p className="mb-2 text-fh-base font-semibold text-fh-fg">Add a comment</p>
                <MarkdownEditor
                  id="new-comment"
                  draftKey={`${handle}/${repoName}#${number}`}
                  value={commentBody}
                  onValueChange={setCommentBody}
                  onSubmit={() => void submitComment()}
                  token={token}
                  repo={repoRef}
                />
                <div className="flex items-center justify-end mt-3">
                  <Button type="submit" variant="primary" loading={submitting} disabled={!commentBody.trim()}>
                    Comment
                  </Button>
                </div>
              </div>
            </form>
          </div>

          <PullSidebar
            token={token}
            handle={handle}
            repoName={repoName}
            pr={pr}
            user={user}
            participants={participants}
            canWrite={canWrite}
            canConvertToDraft={isAuthor || canAdmin}
            onChange={(patch) => setPr((prev) => (prev ? { ...prev, ...patch } : prev))}
            onTimelineChange={refreshTimeline}
          />
        </div>
      )}

      {/* Commits tab: grouped by day, oldest first, as GitHub lists them */}
      {activeTab === "commits" &&
        (commitsLoading || commits === null ? (
          <div className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton variant="circle" width={20} height={20} />
                <Skeleton className="flex-1 h-4 rounded" />
                <Skeleton width={56} height={20} className="rounded" />
              </div>
            ))}
          </div>
        ) : commits.length === 0 ? (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-10 text-center text-fh-sm text-fh-fg-muted">
            No commits found between these branches.
          </div>
        ) : (
          <div className="space-y-5">
            {commitsByDay([...commits].reverse()).map(([day, list]) => (
              <section key={day}>
                <h3 className="flex items-center gap-2 mb-2 text-fh-sm text-fh-fg-muted">
                  <GitCommitIcon size={15} />
                  Commits on {day}
                </h3>
                <ul className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
                  {list.map((c) => (
                    <li key={c.sha} className="flex items-center gap-3 px-4 py-2.5 hover:bg-fh-surface-muted/60 transition-colors">
                      <Avatar name={c.authorName} size={20} />
                      <div className="flex-1 min-w-0">
                        <Link to={`${base}/commits/${c.sha}`} className="block truncate text-fh-sm font-semibold text-fh-fg hover:text-fh-accent-fg">
                          {c.subject}
                        </Link>
                        <p className="text-fh-xs text-fh-fg-muted">
                          {c.authorName} committed <RelativeTime date={c.date} />
                        </p>
                      </div>
                      <SignatureBadge signature={c.signature} />
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
              </section>
            ))}
          </div>
        ))}

      {/* Checks tab */}
      {activeTab === "checks" &&
        (checkCount ? (
          <PRChecks token={token} handle={handle} repoName={repoName} pr={pr} base={base} />
        ) : (
          <EmptyState
            icon={<ChecksIcon size={24} />}
            title="No checks on this pull request"
            description="Workflows in .forgehub/workflows run on every push, and their checks show here."
            bordered
          />
        ))}

      {/* Files tab */}
      {activeTab === "files" &&
        (filesLoading || prFiles === null ? (
          <div className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border overflow-hidden">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton width={12} height={12} className="rounded" />
                <Skeleton className="flex-1 h-4 rounded" />
                <Skeleton width={48} height={16} className="rounded" />
              </div>
            ))}
          </div>
        ) : prFiles.length === 0 ? (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-10 text-center text-fh-sm text-fh-fg-muted">
            No files changed.
          </div>
        ) : (
          <div className="space-y-3">
            {/* GitHub's Files changed toolbar (#252) */}
            <div className="flex items-center gap-2 flex-wrap rounded-md border border-fh-border bg-fh-canvas px-3 py-2 text-fh-sm">
              <select
                aria-label="Changes from"
                value={commitSha ?? ""}
                onChange={(e) => setOption("commit", e.target.value || null)}
                className="h-7 max-w-[260px] rounded-md border border-fh-border bg-fh-surface px-2 text-fh-sm text-fh-fg"
              >
                <option value="">All commits</option>
                {(commits ?? []).slice().reverse().map((c) => (
                  <option key={c.sha} value={c.sha}>{c.shortSha} {c.subject}</option>
                ))}
              </select>
              <input
                type="search"
                aria-label="Filter changed files"
                placeholder="Filter files…"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                className="h-7 w-44 rounded-md border border-fh-border bg-fh-surface px-2 text-fh-sm text-fh-fg"
              />
              <div role="group" aria-label="Diff view" className="inline-flex overflow-hidden rounded-md border border-fh-border">
                {(["unified", "split"] as const).map((v, i) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={diffView === v}
                    onClick={() => setOption("diff", v === "split" ? "split" : null)}
                    className={cx("h-7 px-2.5 text-fh-sm", i > 0 && "border-l border-fh-border", diffView === v ? "bg-fh-surface font-semibold text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg")}
                  >
                    {v === "unified" ? "Unified" : "Split"}
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-1.5 text-fh-fg-muted cursor-pointer">
                <input type="checkbox" checked={hideWhitespace} onChange={(e) => setOption("w", e.target.checked ? "1" : null)} />
                Hide whitespace
              </label>
              <span className="text-fh-fg-muted">
                <span className="font-semibold text-fh-fg">{shownFiles.length}</span> {shownFiles.length === 1 ? "file" : "files"}{" "}
                <span className="font-mono font-semibold text-fh-success-fg">+{totalAdditions}</span>{" "}
                <span className="font-mono font-semibold text-fh-danger-fg">−{totalDeletions}</span>
              </span>
              <div className="ml-auto flex items-center gap-3">
                {canComment && !commitSha && (
                  <span className="text-fh-xs text-fh-fg-subtle">
                    Hover a line and click <span className="font-semibold text-fh-accent-fg">+</span> to comment
                  </span>
                )}
                {/* Submit review, in the toolbar as on GitHub */}
                {pr.state === "open" && (
                  <Popover
                    align="end"
                    width={420}
                    trigger={(_open, toggle) => (
                      <Button size="sm" variant={pendingCount > 0 ? "primary" : "default"} onClick={toggle}>
                        {isAuthor ? "Review" : "Submit review"}
                        {pendingCount > 0 && <span className="ml-1.5 font-mono">{pendingCount}</span>}
                      </Button>
                    )}
                  >
                    <ReviewSubmitPanel
                      currentUser={user.handle}
                      isAuthor={isAuthor}
                      pendingCount={pendingCount}
                      hasPendingReview={hasPendingReview}
                      busy={reviewBusy}
                      onSubmit={onSubmitReview}
                      onDiscard={onDiscardReview}
                      ctx={{ token, handle, repoName }}
                    />
                  </Popover>
                )}
              </div>
            </div>
            {/* File-tree navigator (issue #119) beside the diff cards. */}
            <div className="flex flex-col md:flex-row gap-4 items-start">
              <div className="w-full md:w-56 shrink-0 md:sticky md:top-16 rounded-md border border-fh-border bg-fh-surface p-2 max-h-[70vh] overflow-y-auto">
                <PRFileTree files={shownFiles} />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                {commitSha && (
                  <p className="rounded-md border border-fh-warning-emphasis/40 bg-fh-warning-muted px-3 py-2 text-fh-sm text-fh-fg">
                    Showing the changes of one commit.{" "}
                    <button type="button" onClick={() => setOption("commit", null)} className="text-fh-accent-fg hover:underline">Show all commits</button>
                  </p>
                )}
                {shownFiles.length === 0 && (
                  <p className="rounded-md border border-fh-border bg-fh-surface px-4 py-6 text-center text-fh-sm text-fh-fg-muted">No changed files match “{fileFilter.trim()}”.</p>
                )}
                {shownFiles.map((file) => (
                  <PRFileRow
                    // A different commit, view or whitespace setting is a different diff: start fresh.
                    key={`${file.path}|${commitSha ?? ""}|${hideWhitespace ? "w" : ""}|${diffView}`}
                    token={token}
                    handle={handle}
                    repoName={repoName}
                    prNumber={number}
                    file={file}
                    base={base}
                    headRef={pr.state === "open" ? pr.fromBranch : (prHead ?? pr.fromBranch)}
                    baseRef={prMergeBase ?? undefined}
                    repoRef={repoRef}
                    comments={reviewComments}
                    // One commit's diff is read-only: review comments anchor to the whole PR's lines.
                    review={commitSha ? { ...reviewInteraction, canComment: false } : reviewInteraction}
                    onToggleViewed={commitSha ? undefined : onToggleViewed}
                    options={{ view: diffView, hideWhitespace, commit: commitSha, headSha: commitSha ?? prHead ?? pr.headSha ?? null }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      {deletingComment && (
        <ConfirmDialog
          title="Delete this comment?"
          message="This can't be undone."
          onConfirm={() => void removeComment()}
          onCancel={() => setDeletingComment(null)}
        />
      )}
    </div>
  );
}

/** Commits grouped under their day ("Nov 5, 2026"), in the order given (the API's is newest first). */
function commitsByDay(commits: CommitInfo[]): Array<[string, CommitInfo[]]> {
  const groups = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const day = new Date(c.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  return [...groups];
}

/** GitHub's "Code" menu on a pull request: how to check its branch out locally. */
function CheckoutMenu({ fromBranch, number }: { fromBranch: string; number: number }) {
  const commands = `git fetch origin\ngit checkout ${fromBranch}`;
  const [copied, setCopied] = useState(false);
  return (
    <Popover
      align="end"
      width={340}
      trigger={(_open, toggle) => (
        <Button size="sm" variant="primary" onClick={toggle}>Code</Button>
      )}
    >
      <div className="p-3 space-y-2">
        <p className="text-fh-sm font-semibold text-fh-fg">Check out this pull request locally</p>
        <pre className="rounded-md border border-fh-border bg-fh-canvas px-3 py-2 font-mono text-fh-xs text-fh-fg whitespace-pre-wrap">{commands}</pre>
        <div className="flex items-center justify-between">
          <span className="text-fh-xs text-fh-fg-subtle">Pull request #{number}</span>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(commands).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/** The checks tab's mark: a circle with a tick, Primer's "checklist" in spirit. */
function ChecksIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2.5 1.75v11.5c0 .138.112.25.25.25h3.17a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.736a.75.75 0 0 1-1.5 0V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13.274 9.537v-.001l-4.557 4.45a.75.75 0 0 1-1.055-.008l-1.943-1.95a.75.75 0 0 1 1.062-1.058l1.419 1.425 4.026-3.932a.75.75 0 1 1 1.048 1.074ZM4.75 4h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM4 7.75A.75.75 0 0 1 4.75 7h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 4 7.75Z" />
    </svg>
  );
}
