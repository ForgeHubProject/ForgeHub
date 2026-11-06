import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  addPullLabel, convertPullToDraft, listLabels, listMilestones, listRepoMembers, removePullLabel, updatePull,
  type RepoMember,
} from "../../../api";
import type { Label, Milestone, PullRequest } from "../../../types";
import { Avatar, Tooltip, useToast } from "../../../ui";
import { SidebarAssignee, SidebarLabels, SidebarMilestone } from "../issues/Sidebar";
import { IssueClosedIcon, IssueOpenedIcon } from "../issues/icons";
import { SidebarHeader } from "../issues/pickers";
import { ReviewersPanel } from "./ReviewersPanel";

/**
 * The pull request's sidebar (#252), GitHub's order: Reviewers, Assignee,
 * Labels, Milestone, Development (the issues it closes), Participants. The
 * issue page's sections are reused; this owns their persistence.
 */
export function PullSidebar({
  token,
  handle,
  repoName,
  pr,
  user,
  participants,
  canWrite,
  canConvertToDraft,
  onChange,
  onTimelineChange,
}: {
  token: string;
  handle: string;
  repoName: string;
  pr: PullRequest;
  user: { handle: string };
  /** Handles of everyone who took part: the author, commenters, reviewers. */
  participants: string[];
  canWrite: boolean;
  canConvertToDraft: boolean;
  onChange: (patch: Partial<PullRequest>) => void;
  /** Something that records a timeline event changed; refetch it. */
  onTimelineChange: () => void;
}) {
  const base = `/${handle}/${repoName}`;
  const { toast } = useToast();
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    listLabels(token, handle, repoName).then((d) => setAllLabels(d.labels)).catch(() => {});
    listRepoMembers(token, handle, repoName).then((d) => setMembers(d.members)).catch(() => {});
    listMilestones(token, handle, repoName, "open").then((d) => setMilestones(d.milestones)).catch(() => {});
  }, [token, handle, repoName]);

  const fail = (what: string) => (err: unknown) =>
    toast(`Couldn't ${what}${err instanceof Error ? `: ${err.message}` : ""}`, { tone: "danger" });

  async function toggleLabel(label: Label) {
    const labels = pr.labels ?? [];
    const on = labels.some((l) => l.id === label.id);
    onChange({ labels: on ? labels.filter((l) => l.id !== label.id) : [...labels, label] });
    try {
      if (on) await removePullLabel(token, handle, repoName, pr.number, label.id);
      else await addPullLabel(token, handle, repoName, pr.number, label.id);
      onTimelineChange();
    } catch (err) {
      onChange({ labels });
      fail("update the labels")(err);
    }
  }

  async function assign(memberHandle: string | null) {
    const member = memberHandle ? members.find((m) => m.handle === memberHandle) : null;
    const prev = pr.assignee ?? null;
    onChange({ assignee: memberHandle });
    try {
      await updatePull(token, handle, repoName, pr.number, { assigneeId: member ? member.id : null });
      onTimelineChange();
    } catch (err) {
      onChange({ assignee: prev });
      fail("change the assignee")(err);
    }
  }

  async function setMilestone(milestoneId: string | null) {
    try {
      const updated = await updatePull(token, handle, repoName, pr.number, { milestoneId });
      onChange({ milestone: updated.milestone ?? null });
      onTimelineChange();
    } catch (err) {
      fail("set the milestone")(err);
    }
  }

  async function toDraft() {
    setConverting(true);
    try {
      await convertPullToDraft(token, handle, repoName, pr.number);
      onChange({ isDraft: true, autoMerge: null });
      onTimelineChange();
    } catch (err) {
      fail("convert to draft")(err);
    } finally {
      setConverting(false);
    }
  }

  const closing = pr.closingIssues ?? [];

  return (
    <aside className="w-full lg:w-64 shrink-0 text-fh-sm">
      <ReviewersPanel
        token={token}
        handle={handle}
        repoName={repoName}
        pr={pr}
        currentUser={user.handle}
        canManage={pr.author === user.handle || canWrite}
        onRequestsChange={(requested) => {
          onChange({ requestedReviewers: requested });
          onTimelineChange();
        }}
      />
      {canConvertToDraft && pr.state === "open" && !pr.isDraft && (
        <p className="-mt-2 mb-4 pb-4 border-b border-fh-border-muted text-fh-xs text-fh-fg-muted">
          Still in progress?{" "}
          <button
            type="button"
            onClick={toDraft}
            disabled={converting}
            className="text-fh-accent-fg hover:underline disabled:opacity-60"
          >
            Convert to draft
          </button>
        </p>
      )}

      <SidebarAssignee members={members} selectedHandle={pr.assignee ?? null} onSelect={assign} canEdit={canWrite} />
      <SidebarLabels allLabels={allLabels} selected={pr.labels ?? []} onToggle={toggleLabel} canEdit={canWrite} />
      <SidebarMilestone
        milestones={milestones}
        selected={pr.milestone ?? null}
        onSelect={setMilestone}
        canEdit={canWrite}
        base={base}
      />

      <section className="pb-4 mb-4 border-b border-fh-border-muted">
        <SidebarHeader title="Development" />
        {closing.length === 0 ? (
          <p className="text-fh-sm text-fh-fg-muted">
            Successfully merging this pull request may close issues it names with <code className="text-fh-xs">fixes #N</code>.
          </p>
        ) : (
          <>
            <p className="text-fh-xs text-fh-fg-muted">Successfully merging this pull request may close these issues.</p>
            <ul className="mt-1.5 space-y-1">
              {closing.map((i) => (
                <li key={i.number} className="flex items-start gap-1.5">
                  {i.state === "open" ? (
                    <IssueOpenedIcon size={14} className="mt-0.5 shrink-0 text-fh-success-fg" />
                  ) : (
                    <IssueClosedIcon size={14} className="mt-0.5 shrink-0 text-fh-purple-fg" />
                  )}
                  <Link to={`${base}/issues/${i.number}`} className="min-w-0 text-fh-sm text-fh-fg hover:text-fh-accent-fg">
                    <span className="break-words">{i.title}</span> <span className="text-fh-fg-subtle">#{i.number}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <SidebarHeader title={`${participants.length} ${participants.length === 1 ? "participant" : "participants"}`} />
        <div className="flex flex-wrap gap-1">
          {participants.map((p) => (
            <Tooltip key={p} label={p}>
              <Link to={`/${p}`} aria-label={p}>
                <Avatar name={p} size={24} />
              </Link>
            </Tooltip>
          ))}
        </div>
      </section>
    </aside>
  );
}
