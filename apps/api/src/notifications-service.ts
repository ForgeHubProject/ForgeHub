import { prisma } from "./prisma.js";

export type NotificationSubjectType = "ISSUE" | "PULL_REQUEST" | "RELEASE";
export type NotificationReason = "ASSIGNED" | "COMMENT" | "REVIEW_REQUESTED" | "SUBSCRIBED" | "MENTIONED";

type EventParams = {
  actorId: string;
  repoId: string;
  subjectType: NotificationSubjectType;
  subjectId: string;
  subjectTitle: string;
  reason: NotificationReason;
};

// Upsert: one notification per (user, subject). New activity marks it unread.
async function notify(userId: string, p: EventParams): Promise<void> {
  await prisma.notification.upsert({
    where: { userId_subjectId: { userId, subjectId: p.subjectId } },
    create: { userId, repoId: p.repoId, subjectType: p.subjectType, subjectId: p.subjectId, subjectTitle: p.subjectTitle, reason: p.reason, read: false },
    update: { read: false, reason: p.reason, subjectTitle: p.subjectTitle, updatedAt: new Date() },
  });
}

// Fan out to repo owner + all collaborators, excluding the actor.
export async function notifySubscribers(p: EventParams): Promise<void> {
  const repo = await prisma.repo.findUnique({
    where: { id: p.repoId },
    select: { ownerId: true, collaborators: { select: { userId: true } } },
  });
  if (!repo) return;

  const subscribers = [repo.ownerId, ...repo.collaborators.map((c) => c.userId)];
  await Promise.all(
    subscribers
      .filter((uid) => uid !== p.actorId)
      .map((uid) => notify(uid, p)),
  );
}

// Notify a single specific user, skipping self-notification.
export async function notifyUser(userId: string, p: EventParams): Promise<void> {
  if (userId === p.actorId) return;
  await notify(userId, p);
}
