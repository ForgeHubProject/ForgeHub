import { prisma } from "./prisma.js";

/** Which conversation a timeline event belongs to. */
export type ConversationSubjectType = "ISSUE" | "PULL_REQUEST";

/**
 * v0 event kinds. `data` carries the per-kind payload (denormalized so history
 * survives label/user deletion). Kept as free-form strings — new kinds slot in
 * without a schema change.
 */
export type TimelineEventKind =
  | "labeled"
  | "unlabeled"
  | "assigned"
  | "unassigned"
  | "closed"
  | "reopened"
  | "merged"
  | "reviewed"
  | "referenced"
  | "head_pushed"
  | "title_changed"
  // Issue triage (#120)
  | "pinned"
  | "unpinned"
  | "locked"
  | "unlocked"
  | "transferred";

export type RecordEventParams = {
  repoId: string;
  subjectType: ConversationSubjectType;
  subjectNumber: number;
  kind: TimelineEventKind;
  actorId: string;
  /** Actor handle; looked up from the actor id when omitted. */
  actorHandle?: string;
  /** Per-kind payload; merged with the (denormalized) actor handle. */
  data?: Record<string, unknown>;
};

async function resolveHandle(actorId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: actorId }, select: { handle: true } });
  return user?.handle ?? "ghost";
}

/**
 * Append one timeline event. Denormalizes the actor handle into `data` so the read
 * side needs no join. Best-effort by design — callers treat it as a side effect.
 */
export async function recordEvent(p: RecordEventParams): Promise<void> {
  const actorHandle = p.actorHandle ?? (await resolveHandle(p.actorId));
  await prisma.timelineEvent.create({
    data: {
      repoId: p.repoId,
      subjectType: p.subjectType,
      subjectNumber: p.subjectNumber,
      kind: p.kind,
      actorId: p.actorId,
      data: JSON.stringify({ actorHandle, ...(p.data ?? {}) }),
    },
  });
}

/**
 * After a push, emit a `head_pushed` event on every OPEN pull request whose head
 * (`fromBranch`) is one of the branches that changed. Zero extra git work — the
 * caller already diffed the SHAs.
 */
export async function emitHeadPushedForPush(
  repoId: string,
  actorId: string,
  changed: Array<{ branch: string; oldSha: string; newSha: string }>,
): Promise<void> {
  if (changed.length === 0) return;
  const byBranch = new Map(changed.map((c) => [c.branch, c]));

  const openPrs = await prisma.pullRequest.findMany({
    where: { repoId, state: "OPEN", fromBranch: { in: [...byBranch.keys()] } },
    select: { number: true, fromBranch: true },
  });
  if (openPrs.length === 0) return;

  const actorHandle = await resolveHandle(actorId);
  for (const pr of openPrs) {
    const change = byBranch.get(pr.fromBranch);
    if (!change) continue;
    await recordEvent({
      repoId,
      subjectType: "PULL_REQUEST",
      subjectNumber: pr.number,
      kind: "head_pushed",
      actorId,
      actorHandle,
      data: { branch: change.branch, oldSha: change.oldSha, newSha: change.newSha },
    });
  }
}
