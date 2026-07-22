import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { verifyUnsubscribeToken } from "../unsubscribe.js";

// Minimal confirmation page for the browser-facing (GET) unsubscribe link.
function unsubscribePage(ok: boolean): string {
  const title = ok ? "Unsubscribed" : "Invalid link";
  const message = ok
    ? "Email notifications have been turned off for your ForgeHub account. You can turn them back on any time from the Notifications page."
    : "This unsubscribe link is invalid or has been tampered with. No changes were made.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · ForgeHub</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f8fa;color:#1f2328;margin:0;padding:48px 16px}
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #d1d9e0;border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#59636e;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

async function applyUnsubscribe(token: string | undefined): Promise<boolean> {
  const userId = token ? verifyUnsubscribeToken(token) : null;
  if (!userId) return false;
  try {
    await prisma.user.update({ where: { id: userId }, data: { emailNotifications: false } });
  } catch {
    // Unknown/deleted user — the link was well-formed, treat as a no-op success.
  }
  return true;
}

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
  // ── One-click unsubscribe (no auth; identity is proven by the signed token) ──
  // GET is the human-facing link in the email body → HTML confirmation.
  app.get("/notifications/unsubscribe", async (request, reply) => {
    const { token } = request.query as { token?: string };
    const ok = await applyUnsubscribe(token);
    return reply.status(ok ? 200 : 400).type("text/html").send(unsubscribePage(ok));
  });

  // POST backs the RFC 8058 List-Unsubscribe-Post one-click header.
  app.post("/notifications/unsubscribe", async (request, reply) => {
    const q = request.query as { token?: string };
    const body = (request.body ?? {}) as { token?: string };
    const ok = await applyUnsubscribe(q.token ?? body.token);
    return reply.status(ok ? 200 : 400).send(ok ? { ok: true } : { error: "Invalid unsubscribe token" });
  });

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
