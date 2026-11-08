import { prisma } from "./prisma.js";
import { parseReferences } from "./references.js";
import { recordEvent, type ConversationSubjectType } from "./timeline-service.js";
import { notifyUser } from "./notifications-service.js";
import { canRead, type RepoAccessInput } from "./repo-access.js";

export type CrossRefSourceType =
  | "ISSUE"
  | "ISSUE_COMMENT"
  | "PULL_REQUEST"
  | "PR_COMMENT"
  | "PR_REVIEW_COMMENT";

/**
 * The caller's repo, carrying the access-relevant relations (`repoAccessInclude`)
 * so the mention loop can hand it straight to `notifyUser` rather than making it
 * re-load the same row — including every org membership and team member set —
 * once per @handle.
 */
type RepoForRefs = RepoAccessInput & { id: string };

// The full read rule (collaborators, org owners, team grants): a narrower check
// here used to skip people who read a private org repository through a team.
function canUserRead(repo: RepoForRefs, userId: string): boolean {
  return canRead(repo, userId);
}

async function resolveHandle(actorId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: actorId }, select: { handle: true } });
  return user?.handle ?? "ghost";
}

type SyncParams = {
  repo: RepoForRefs;
  actorId: string;
  /** The granular body-bearing record the refs were parsed from. */
  source: { type: CrossRefSourceType; id: string };
  /** The issue/PR that owns this body — used for the link-back event + mentions. */
  container: {
    subjectType: ConversationSubjectType;
    id: string;
    number: number;
    title: string;
  };
  body: string | null | undefined;
};

type DesiredRef = {
  targetType: ConversationSubjectType;
  targetId: string;
  targetNumber: number;
  isClosingRef: boolean;
};

/**
 * Re-parse a body and reconcile its cross-references. Newly-referenced targets get
 * a `referenced` timeline event (link-back) and closing refs are flagged; removed
 * references are dropped (history/events are append-only and stay). Mentions notify
 * readers of the repo, once each, skipping the actor.
 */
export async function syncBodyReferences(p: SyncParams): Promise<void> {
  const parsed = parseReferences(p.body);

  // ── Resolve #N → issue or pull, !N → pull, into the desired reference set ─────
  const desired = new Map<string, DesiredRef>();
  const key = (t: ConversationSubjectType, id: string) => `${t}#${id}`;

  for (const number of parsed.numbers) {
    // One sequence for both (#259). Repos numbered before it can hold an issue and
    // a pull request with the same number; `#N` meant the issue then, and still does.
    const issue = await prisma.issue.findFirst({
      where: { repoId: p.repo.id, number },
      select: { id: true, number: true },
    });
    if (issue) {
      if (issue.id === p.container.id) continue;
      desired.set(key("ISSUE", issue.id), {
        targetType: "ISSUE",
        targetId: issue.id,
        targetNumber: issue.number,
        isClosingRef: parsed.closing.includes(number),
      });
      continue;
    }
    const pull = await prisma.pullRequest.findFirst({
      where: { repoId: p.repo.id, number },
      select: { id: true, number: true },
    });
    if (!pull || pull.id === p.container.id) continue;
    // A closing keyword closes issues only; on a pull request it's a plain reference.
    desired.set(key("PULL_REQUEST", pull.id), {
      targetType: "PULL_REQUEST",
      targetId: pull.id,
      targetNumber: pull.number,
      isClosingRef: false,
    });
  }

  for (const number of parsed.pulls) {
    const pull = await prisma.pullRequest.findFirst({
      where: { repoId: p.repo.id, number },
      select: { id: true, number: true },
    });
    if (!pull || pull.id === p.container.id) continue;
    desired.set(key("PULL_REQUEST", pull.id), {
      targetType: "PULL_REQUEST",
      targetId: pull.id,
      targetNumber: pull.number,
      isClosingRef: false,
    });
  }

  // ── Diff against existing rows for this source ────────────────────────────────
  const existing = await prisma.crossReference.findMany({
    where: { sourceType: p.source.type, sourceId: p.source.id },
  });
  const existingByKey = new Map(existing.map((r) => [key(r.targetType as ConversationSubjectType, r.targetId), r]));

  const toDelete = existing.filter((r) => !desired.has(key(r.targetType as ConversationSubjectType, r.targetId)));
  if (toDelete.length > 0) {
    await prisma.crossReference.deleteMany({ where: { id: { in: toDelete.map((r) => r.id) } } });
  }

  const actorHandle = await resolveHandle(p.actorId);

  for (const ref of desired.values()) {
    const prev = existingByKey.get(key(ref.targetType, ref.targetId));
    if (prev) {
      // Existing reference: only sync the closing flag, no new event.
      if (prev.isClosingRef !== ref.isClosingRef) {
        await prisma.crossReference.update({ where: { id: prev.id }, data: { isClosingRef: ref.isClosingRef } });
      }
      continue;
    }
    // Newly-added reference: persist it and emit a link-back event on the target.
    await prisma.crossReference.create({
      data: {
        repoId: p.repo.id,
        sourceType: p.source.type,
        sourceId: p.source.id,
        targetType: ref.targetType,
        targetId: ref.targetId,
        targetNumber: ref.targetNumber,
        actorId: p.actorId,
        isClosingRef: ref.isClosingRef,
      },
    });
    await recordEvent({
      repoId: p.repo.id,
      subjectType: ref.targetType,
      subjectNumber: ref.targetNumber,
      kind: "referenced",
      actorId: p.actorId,
      actorHandle,
      data: {
        sourceType: p.container.subjectType,
        sourceNumber: p.container.number,
        sourceTitle: p.container.title,
      },
    });
  }

  // ── Mentions → notifications (once per reader, never the actor) ────────────────
  const mentioned = new Set<string>();
  for (const handle of parsed.mentions) {
    const user = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
    if (!user || user.id === p.actorId) continue;
    mentioned.add(user.id);
    if (!canUserRead(p.repo, user.id)) continue;
    // The repo we already hold is the access row `notifyUser` would otherwise
    // load for itself, once per mention.
    await notifyUser(
      user.id,
      {
        actorId: p.actorId,
        repoId: p.repo.id,
        subjectType: p.container.subjectType,
        subjectId: p.container.id,
        subjectTitle: p.container.title,
        reason: "MENTIONED",
      },
      p.repo,
    );
  }

  // ── Team mentions (#253) → each member who can read, once ─────────────────────
  // Only the repository's own organization's teams, and only from someone in that
  // organization, so a stranger on a public repository can't page whole teams.
  if (parsed.teamMentions.length > 0 && p.repo.orgId) {
    const org = await prisma.organization.findUnique({
      where: { id: p.repo.orgId },
      select: { handle: true, memberships: { where: { userId: p.actorId }, select: { userId: true } } },
    });
    if (org && org.memberships.length > 0) {
      const slugs = parsed.teamMentions.filter((t) => t.startsWith(`${org.handle}/`)).map((t) => t.slice(org.handle.length + 1));
      const teams = slugs.length
        ? await prisma.team.findMany({
            where: { orgId: p.repo.orgId, slug: { in: slugs } },
            select: { memberships: { select: { userId: true } } },
          })
        : [];
      const members = new Set(teams.flatMap((t) => t.memberships.map((m) => m.userId)));
      for (const userId of members) {
        if (userId === p.actorId || mentioned.has(userId) || !canUserRead(p.repo, userId)) continue;
        await notifyUser(
          userId,
          {
            actorId: p.actorId,
            repoId: p.repo.id,
            subjectType: p.container.subjectType,
            subjectId: p.container.id,
            subjectTitle: p.container.title,
            reason: "TEAM_MENTIONED",
          },
          p.repo,
        );
      }
    }
  }
}

/**
 * When a PR merges, close every issue it references with a closing keyword and
 * record a `closed` event (actor = the merger). Only OPEN issues are touched.
 */
export async function closeIssuesForMergedPull(p: {
  repoId: string;
  prId: string;
  prNumber: number;
  mergerId: string;
  mergerHandle?: string;
}): Promise<void> {
  const closing = await prisma.crossReference.findMany({
    where: { sourceType: "PULL_REQUEST", sourceId: p.prId, isClosingRef: true, targetType: "ISSUE" },
  });
  if (closing.length === 0) return;

  const mergerHandle = p.mergerHandle ?? (await resolveHandle(p.mergerId));

  for (const ref of closing) {
    const issue = await prisma.issue.findFirst({ where: { id: ref.targetId }, select: { id: true, state: true } });
    if (!issue || issue.state !== "OPEN") continue;
    await prisma.issue.update({
      where: { id: issue.id },
      data: { state: "CLOSED", closedAt: new Date() },
    });
    await recordEvent({
      repoId: p.repoId,
      subjectType: "ISSUE",
      subjectNumber: ref.targetNumber,
      kind: "closed",
      actorId: p.mergerId,
      actorHandle: mergerHandle,
      data: { closedByPull: p.prNumber },
    });
  }
}
