import { prisma } from "./prisma.js";
import { parseReferences } from "./references.js";
import { recordEvent, type ConversationSubjectType } from "./timeline-service.js";
import { notifyUser } from "./notifications-service.js";

export type CrossRefSourceType =
  | "ISSUE"
  | "ISSUE_COMMENT"
  | "PULL_REQUEST"
  | "PR_COMMENT"
  | "PR_REVIEW_COMMENT";

type RepoForRefs = {
  id: string;
  visibility: "PUBLIC" | "PRIVATE";
  ownerId: string;
  collaborators: Array<{ userId: string }>;
};

function canUserRead(repo: RepoForRefs, userId: string): boolean {
  if (repo.visibility === "PUBLIC") return true;
  if (repo.ownerId === userId) return true;
  return repo.collaborators.some((c) => c.userId === userId);
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

  // ── Resolve #N → issue and !N → pull, into the desired reference set ──────────
  const desired = new Map<string, DesiredRef>();
  const key = (t: ConversationSubjectType, id: string) => `${t}#${id}`;

  for (const number of parsed.issues) {
    if (p.container.subjectType === "ISSUE" && number === p.container.number) continue;
    const issue = await prisma.issue.findFirst({
      where: { repoId: p.repo.id, number },
      select: { id: true, number: true },
    });
    if (!issue) continue;
    desired.set(key("ISSUE", issue.id), {
      targetType: "ISSUE",
      targetId: issue.id,
      targetNumber: issue.number,
      isClosingRef: parsed.closesIssues.includes(number),
    });
  }

  for (const number of parsed.pulls) {
    if (p.container.subjectType === "PULL_REQUEST" && number === p.container.number) continue;
    const pull = await prisma.pullRequest.findFirst({
      where: { repoId: p.repo.id, number },
      select: { id: true, number: true },
    });
    if (!pull) continue;
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
  for (const handle of parsed.mentions) {
    const user = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
    if (!user || user.id === p.actorId) continue;
    if (!canUserRead(p.repo, user.id)) continue;
    await notifyUser(user.id, {
      actorId: p.actorId,
      repoId: p.repo.id,
      subjectType: p.container.subjectType,
      subjectId: p.container.id,
      subjectTitle: p.container.title,
      reason: "MENTIONED",
    });
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
