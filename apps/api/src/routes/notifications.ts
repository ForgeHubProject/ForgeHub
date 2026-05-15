import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";

function formatNotification(n: {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  reason: string;
  read: boolean;
  repoId: string;
  repo: { name: string; owner: { handle: string } };
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: n.id,
    subjectType: n.subjectType.toLowerCase(),
    subjectId: n.subjectId,
    subjectTitle: n.subjectTitle,
    reason: n.reason.toLowerCase(),
    read: n.read,
    repo: `${n.repo.owner.handle}/${n.repo.name}`,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

const notifInclude = {
  repo: { select: { name: true, owner: { select: { handle: true } } } },
} as const;

export async function notificationRoutes(app: FastifyInstance) {
  // GET /notifications?all=true   (all=false → unread only, default)
  app.get("/notifications", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const { all } = request.query as { all?: string };
    const showAll = all === "true";

    const notifications = await prisma.notification.findMany({
      where: { userId, ...(showAll ? {} : { read: false }) },
      include: notifInclude,
      orderBy: { updatedAt: "desc" },
    });
    return { notifications: notifications.map(formatNotification) };
  });

  // PATCH /notifications  — mark all as read
  app.patch("/notifications", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
    return reply.status(204).send();
  });

  // PATCH /notifications/:id  — mark one as read
  app.patch("/notifications/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;

    const notif = await prisma.notification.findFirst({ where: { id, userId } });
    if (!notif) return reply.status(404).send({ error: "Notification not found" });

    const updated = await prisma.notification.update({
      where: { id },
      data: { read: true },
      include: notifInclude,
    });
    return formatNotification(updated);
  });

  // DELETE /notifications/:id
  app.delete("/notifications/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;

    const notif = await prisma.notification.findFirst({ where: { id, userId } });
    if (!notif) return reply.status(404).send({ error: "Notification not found" });

    await prisma.notification.delete({ where: { id } });
    return reply.status(204).send();
  });

  // GET /repos/:handle/:name/notifications  — repo-scoped inbox
  app.get("/repos/:handle/:name/notifications", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const { all } = request.query as { all?: string };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const notifications = await prisma.notification.findMany({
      where: { userId, repoId: repo.id, ...(all === "true" ? {} : { read: false }) },
      include: notifInclude,
      orderBy: { updatedAt: "desc" },
    });
    return { notifications: notifications.map(formatNotification) };
  });
}
