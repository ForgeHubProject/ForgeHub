import { prisma } from "./prisma.js";
import { canRead, repoAccessInclude, type RepoAccessInput } from "./repo-access.js";
import { sendNotificationEmail } from "./email-notify.js";

export type NotificationSubjectType = "ISSUE" | "PULL_REQUEST" | "RELEASE";
export type NotificationReason = "ASSIGNED" | "COMMENT" | "REVIEW_REQUESTED" | "SUBSCRIBED" | "MENTIONED" | "TEAM_MENTIONED";

export type EventParams = {
  actorId: string;
  repoId: string;
  subjectType: NotificationSubjectType;
  subjectId: string;
  subjectTitle: string;
  reason: NotificationReason;
};

/** What unsubscribing from a conversation stops (#258); being addressed directly still notifies. */
const MUTABLE_IN_THREAD: ReadonlySet<NotificationReason> = new Set(["SUBSCRIBED", "COMMENT"]);

/** Whether a reason reaches the inbox and email (#258); a reason with no stored choice is on for both. */
export function reasonPrefs(raw: string | null | undefined, reason: NotificationReason): { web: boolean; email: boolean } {
  let stored: unknown;
  try {
    stored = raw ? (JSON.parse(raw) as Record<string, unknown>)[reason] : undefined;
  } catch {
    stored = undefined;
  }
  const pick = (k: "web" | "email") =>
    stored && typeof stored === "object" && typeof (stored as Record<string, unknown>)[k] === "boolean" ? ((stored as Record<string, boolean>)[k]) : true;
  return { web: pick("web"), email: pick("email") };
}

// Upsert: one notification per (user, subject). New activity marks it unread.
// Email is a second, best-effort sink: we mail only on a transition into unread
// (brand-new, or previously-read) so a burst of micro-updates on one subject
// doesn't spam. Delivery is fire-and-forget and can never fail this call.
// The recipient's preferences pick the sinks per reason, and someone they
// blocked never reaches them (#258).
async function notify(userId: string, p: EventParams): Promise<void> {
  const recipient = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      notificationPrefs: true,
      blocking: { where: { blockedId: p.actorId }, select: { blockedId: true } },
      threadMutes: { where: { subjectId: p.subjectId }, select: { subjectId: true } },
    },
  });
  if (recipient?.blocking?.length) return;
  // An unsubscribed conversation stays quiet unless they're addressed directly.
  if (recipient?.threadMutes?.length && MUTABLE_IN_THREAD.has(p.reason)) return;
  const prefs = reasonPrefs(recipient?.notificationPrefs, p.reason);

  let transitionedToUnread = true; // email-only: every event mails
  if (prefs.web) {
    const existing = await prisma.notification.findUnique({
      where: { userId_subjectId: { userId, subjectId: p.subjectId } },
      select: { read: true },
    });
    await prisma.notification.upsert({
      where: { userId_subjectId: { userId, subjectId: p.subjectId } },
      create: { userId, repoId: p.repoId, subjectType: p.subjectType, subjectId: p.subjectId, subjectTitle: p.subjectTitle, reason: p.reason, read: false },
      // New activity brings a done thread back to the inbox.
      update: { read: false, done: false, reason: p.reason, subjectTitle: p.subjectTitle, updatedAt: new Date() },
    });
    transitionedToUnread = !existing || existing.read === true;
  }
  if (prefs.email && transitionedToUnread) {
    void sendNotificationEmail(userId, p);
  }
}

// The access-relevant repo row, or null when the repo is gone. Every delivery
// path re-checks read access against this: a Watch row is a subscription, never
// a grant, and it can outlive the grant that justified it (collaborator removed,
// team access revoked, org membership dropped, repo flipped to private). The
// check at *delivery* time is what holds under access paths that do not exist
// yet — a private repo's titles must never reach someone who cannot read it.
async function loadRepoAccess(repoId: string) {
  return prisma.repo.findUnique({ where: { id: repoId }, include: repoAccessInclude });
}

// Fan out to the repo's watchers (issue #88), excluding the actor. The set is
// data-driven: every explicit Watch row at level ALL subscribes its user, and an
// owner/collaborator WITHOUT a row is treated as an implicit ALL watcher — the
// rows are materialized on repo create / collaborator add (plus a startup
// backfill), but a missed write must never silently unsubscribe them. A row at
// PARTICIPATING or IGNORE keeps its user out of this fan-out; PARTICIPATING
// users still receive the direct reasons via notifyUser below. The final
// recipient set is intersected with live read access (see loadRepoAccess).
export async function notifySubscribers(p: EventParams): Promise<void> {
  const repo = await loadRepoAccess(p.repoId);
  if (!repo) return;

  const watches = await prisma.watch.findMany({
    where: { repoId: p.repoId },
    select: { userId: true, level: true },
  });
  const levelByUser = new Map(watches.map((w) => [w.userId, w.level]));

  const subscribers = new Set<string>();
  for (const w of watches) {
    if (w.level === "ALL") subscribers.add(w.userId);
  }
  for (const uid of [repo.ownerId, ...repo.collaborators.map((c) => c.userId)]) {
    if (!levelByUser.has(uid)) subscribers.add(uid);
  }
  subscribers.delete(p.actorId);

  const recipients = [...subscribers].filter((uid) => canRead(repo, uid));
  await Promise.all(recipients.map((uid) => notify(uid, p)));
}

// Reasons an IGNORE watch cannot mute. A review request is *addressed to a
// person* and blocks the PR until they act on it — unlike a mention or an
// assignment, dropping it strands the requester waiting on a review the
// reviewer was never told about. Muting a repo says "stop subscribing me to its
// activity", not "answer for me when someone asks me directly" (issues #88/#82).
const UNMUTABLE_REASONS: ReadonlySet<NotificationReason> = new Set(["REVIEW_REQUESTED"]);

// Notify a single specific user (mentioned / assigned / review-requested /
// thread-comment), skipping self-notification. An IGNORE watch actually mutes:
// it suppresses these direct reasons too (issue #88), except the ones in
// UNMUTABLE_REASONS. Read access is re-checked
// here too — a direct reason is no licence to leak a private repo's subject.
// `loaded` lets a caller that already holds the access-relevant repo row hand it
// over instead of paying for the (heavy: org memberships + team member sets)
// load again — the mention loop calls this once per @handle.
export async function notifyUser(
  userId: string,
  p: EventParams,
  loaded?: RepoAccessInput,
): Promise<void> {
  if (userId === p.actorId) return;
  const [repo, watch] = await Promise.all([
    loaded ?? loadRepoAccess(p.repoId),
    prisma.watch.findUnique({
      where: { userId_repoId: { userId, repoId: p.repoId } },
      select: { level: true },
    }),
  ]);
  if (!repo || !canRead(repo, userId)) return;
  if (watch?.level === "IGNORE" && !UNMUTABLE_REASONS.has(p.reason)) return;
  await notify(userId, p);
}
