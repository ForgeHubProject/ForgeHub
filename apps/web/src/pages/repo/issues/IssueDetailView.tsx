import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Avatar, Badge, Button, EmptyState, RelativeTime, Skeleton, Textarea, TextInput,
} from "../../../ui";
import {
  addIssueLabel, createIssueComment, getIssue, listIssueComments, listIssueTimeline, listLabels,
  listRepoMembers, removeIssueLabel, RepoMember, updateIssue,
} from "../../../api";
import { MarkdownRenderer } from "../../../components/MarkdownRenderer";
import { TimelineEventRow } from "../../../components/TimelineEventRow";
import type { Issue, IssueComment, Label, TimelineEvent, User } from "../../../types";
import { StatePill, UserLink } from "./parts";
import { SidebarLabels, SidebarAssignee } from "./Sidebar";
import { ChevronLeftIcon, IssueClosedIcon, IssueOpenedIcon, PencilIcon } from "./icons";

/** One timeline entry: an author header bar over a rendered-markdown body. */
function TimelineCard({
  author,
  date,
  badge,
  children,
}: {
  author: string;
  date: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-fh-border rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 bg-fh-surface-muted border-b border-fh-border text-fh-sm">
        <Avatar name={author} size={20} />
        <UserLink handle={author} />
        <span className="text-fh-fg-muted">commented <RelativeTime date={date} /></span>
        {badge && <span className="ml-1">{badge}</span>}
      </div>
      <div className="px-4 py-4 bg-fh-surface">{children}</div>
    </div>
  );
}

export function IssueDetailView({ token, handle, repoName, user, number }: {
  token: string; handle: string; repoName: string; user: User; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const repoRef = { owner: handle, name: repoName };

  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getIssue(token, handle, repoName, number),
      listIssueComments(token, handle, repoName, number),
      listLabels(token, handle, repoName).catch(() => ({ labels: [] })),
      listRepoMembers(token, handle, repoName).catch(() => ({ members: [] })),
      listIssueTimeline(token, handle, repoName, number).catch(() => ({ events: [] })),
    ])
      .then(([iss, cmts, lbl, mem, tl]) => {
        setIssue(iss);
        setComments(cmts.comments);
        setAllLabels(lbl.labels);
        setMembers(mem.members);
        setEvents(tl.events);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Issue not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  function refreshTimeline() {
    listIssueTimeline(token, handle, repoName, number)
      .then((tl) => setEvents(tl.events))
      .catch(() => { /* keep prior events on failure */ });
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmitting(true);
    try {
      const c = await createIssueComment(token, handle, repoName, number, commentBody.trim());
      setComments((prev) => [...prev, c]);
      setCommentBody("");
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to comment");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleState() {
    if (!issue) return;
    setToggling(true);
    try {
      const updated = await updateIssue(token, handle, repoName, number, {
        state: issue.state === "open" ? "closed" : "open",
      });
      setIssue(updated);
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setToggling(false);
    }
  }

  async function saveTitle() {
    if (!issue || !titleDraft.trim() || titleDraft.trim() === issue.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const updated = await updateIssue(token, handle, repoName, number, { title: titleDraft.trim() });
      setIssue(updated);
      setEditingTitle(false);
      refreshTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setSavingTitle(false);
    }
  }

  async function toggleLabel(label: Label) {
    if (!issue) return;
    const has = issue.labels.some((l) => l.id === label.id);
    try {
      if (has) {
        await removeIssueLabel(token, handle, repoName, number, label.id);
        setIssue({ ...issue, labels: issue.labels.filter((l) => l.id !== label.id) });
      } else {
        await addIssueLabel(token, handle, repoName, number, label.id);
        setIssue({ ...issue, labels: [...issue.labels, label] });
      }
      refreshTimeline();
    } catch { /* keep prior state on failure */ }
  }

  async function setAssignee(nextHandle: string | null) {
    if (!issue) return;
    const member = nextHandle ? members.find((m) => m.handle === nextHandle) : null;
    try {
      const updated = await updateIssue(token, handle, repoName, number, {
        assigneeId: member ? member.id : null,
      });
      setIssue(updated);
      refreshTimeline();
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !issue) {
    return (
      <EmptyState
        bordered
        title="Issue not found"
        description={error ?? "This issue may have been deleted."}
        actions={<Button variant="default" onClick={() => navigate(`${base}/issues`)}>Back to issues</Button>}
      />
    );
  }

  const isOpen = issue.state === "open";
  const canEdit = issue.author === user.handle || handle === user.handle;

  // Comments and non-comment events, interleaved chronologically.
  const stream = [
    ...comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, comment: c })),
    ...events.map((e) => ({ kind: "event" as const, at: e.createdAt, event: e })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return (
    <div>
      <Link
        to={`${base}/issues`}
        className="inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-3"
      >
        <ChevronLeftIcon size={14} />
        Issues
      </Link>

      {/* Title */}
      {editingTitle ? (
        <div className="flex items-center gap-2 mb-3">
          <TextInput
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            className="text-fh-lg"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
          />
          <Button variant="primary" size="sm" loading={savingTitle} onClick={saveTitle}>Save</Button>
          <Button variant="default" size="sm" onClick={() => setEditingTitle(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex items-start gap-2 mb-3">
          <h1 className="text-fh-2xl font-semibold text-fh-fg leading-tight flex-1 min-w-0">
            {issue.title}
            <span className="text-fh-fg-subtle font-normal ml-2">#{issue.number}</span>
          </h1>
          {canEdit && (
            <button
              type="button"
              onClick={() => { setTitleDraft(issue.title); setEditingTitle(true); }}
              className="mt-1 inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted hover:text-fh-fg"
            >
              <PencilIcon size={14} /> Edit
            </button>
          )}
        </div>
      )}

      {/* State + meta */}
      <div className="flex items-center gap-3 flex-wrap pb-4 mb-6 border-b border-fh-border">
        <StatePill state={issue.state} />
        <span className="text-fh-sm text-fh-fg-muted">
          <UserLink handle={issue.author} /> opened this issue <RelativeTime date={issue.createdAt} />
          {" · "}
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Timeline */}
        <div className="flex-1 min-w-0 space-y-4">
          <TimelineCard
            author={issue.author}
            date={issue.createdAt}
            badge={<Badge tone="neutral">Author</Badge>}
          >
            {issue.body ? (
              <MarkdownRenderer content={issue.body} repo={repoRef} />
            ) : (
              <p className="text-fh-sm text-fh-fg-muted italic">No description provided.</p>
            )}
          </TimelineCard>

          {stream.map((item) =>
            item.kind === "comment" ? (
              <TimelineCard key={`c-${item.comment.id}`} author={item.comment.author} date={item.comment.createdAt}>
                <MarkdownRenderer content={item.comment.body} repo={repoRef} />
              </TimelineCard>
            ) : (
              <TimelineEventRow key={`e-${item.event.id}`} event={item.event} repo={repoRef} />
            ),
          )}

          {/* Composer */}
          <form onSubmit={submitComment} className="border border-fh-border rounded-md overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 bg-fh-surface-muted border-b border-fh-border text-fh-sm">
              <Avatar name={user.displayName ?? user.handle} size={20} />
              <span className="font-semibold text-fh-fg">Add a comment</span>
            </div>
            <div className="p-3 bg-fh-surface">
              <Textarea
                rows={5}
                placeholder="Leave a comment"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              <p className="mt-1.5 text-fh-xs text-fh-fg-subtle">Styling with Markdown is supported.</p>
              {error && <p className="mt-2 text-fh-sm text-fh-danger-fg">{error}</p>}
              <div className="flex items-center justify-end gap-2 mt-3">
                {canEdit && (
                  <Button
                    variant="default"
                    loading={toggling}
                    onClick={toggleState}
                    leadingIcon={isOpen ? <IssueClosedIcon size={16} /> : <IssueOpenedIcon size={16} />}
                  >
                    {isOpen ? "Close issue" : "Reopen issue"}
                  </Button>
                )}
                <Button type="submit" variant="primary" loading={submitting} disabled={!commentBody.trim()}>
                  Comment
                </Button>
              </div>
            </div>
          </form>
        </div>

        {/* Sidebar */}
        <aside className="w-full lg:w-64 shrink-0">
          <SidebarLabels
            allLabels={allLabels}
            selected={issue.labels}
            onToggle={toggleLabel}
            canEdit={canEdit}
          />
          <SidebarAssignee
            members={members}
            selectedHandle={issue.assignee}
            onSelect={setAssignee}
            canEdit={canEdit}
          />
          <section className="text-fh-sm text-fh-fg-muted">
            <h3 className="text-fh-sm font-semibold text-fh-fg mb-2">Meta</h3>
            <p>Opened <RelativeTime date={issue.createdAt} /></p>
            {issue.closedAt && <p className="mt-1">Closed <RelativeTime date={issue.closedAt} /></p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
