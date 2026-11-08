import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { Prisma } from "@prisma/client";
import { canRead, repoAccessInclude, repoByOwningHandleWhere, resolveRepo } from "../repo-access.js";
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

type NotificationRow = {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  reason: string;
  read: boolean;
  saved: boolean;
  done: boolean;
  repoId: string;
  repo: { name: string; owner: { handle: string }; org: { handle: string } | null };
  createdAt: Date;
  updatedAt: Date;
};

type Subject = { number: number | null; state: string | null; tag?: string };

function formatNotification(n: NotificationRow, subject?: Subject) {
  return {
    id: n.id,
    subjectType: n.subjectType.toLowerCase(),
    subjectId: n.subjectId,
    subjectTitle: n.subjectTitle,
    reason: n.reason.toLowerCase(),
    read: n.read,
    saved: n.saved,
    done: n.done,
    // The owning handle: the organization's for an org repository.
    repo: `${n.repo.org?.handle ?? n.repo.owner.handle}/${n.repo.name}`,
    // What it points at (#258): the issue or pull request number and state, or the release tag.
    number: subject?.number ?? null,
    state: subject?.state ?? null,
    tag: subject?.tag ?? null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

const notifInclude = {
  repo: { select: { name: true, owner: { select: { handle: true } }, org: { select: { handle: true } } } },
} as const;

/** Numbers and states for a page of notifications, a query per subject type. */
async function resolveSubjects(rows: Array<{ subjectType: string; subjectId: string }>): Promise<Map<string, Subject>> {
  const ids = (type: string) => rows.filter((r) => r.subjectType === type).map((r) => r.subjectId);
  const [issues, pulls, releases] = await Promise.all([
    ids("ISSUE").length ? prisma.issue.findMany({ where: { id: { in: ids("ISSUE") } }, select: { id: true, number: true, state: true } }) : [],
    ids("PULL_REQUEST").length
      ? prisma.pullRequest.findMany({ where: { id: { in: ids("PULL_REQUEST") } }, select: { id: true, number: true, state: true } })
      : [],
    ids("RELEASE").length ? prisma.release.findMany({ where: { id: { in: ids("RELEASE") } }, select: { id: true, tagName: true } }) : [],
  ]);
  const out = new Map<string, Subject>();
  for (const i of issues) out.set(i.id, { number: i.number, state: i.state.toLowerCase() });
  for (const p of pulls) out.set(p.id, { number: p.number, state: p.state.toLowerCase() });
  for (const r of releases) out.set(r.id, { number: null, state: null, tag: r.tagName });
  return out;
}

/** The inbox's reason filters (#258), GitHub's names. */
const REASON_FILTERS: Record<string, "ASSIGNED" | "COMMENT" | "MENTIONED" | "TEAM_MENTIONED" | "REVIEW_REQUESTED" | "SUBSCRIBED"> = {
  assigned: "ASSIGNED",
  participating: "COMMENT",
  mentioned: "MENTIONED",
  team_mentioned: "TEAM_MENTIONED",
  review_requested: "REVIEW_REQUESTED",
  watching: "SUBSCRIBED",
};

const BULK_ACTIONS = ["read", "unread", "done", "undone", "save", "unsave", "unsubscribe"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * Apply an inbox action to some of the caller's notifications. Raw SQL so the
 * flags change without touching updatedAt: the inbox is ordered by activity,
 * and reading or filing a notification isn't activity.
 */
async function applyAction(userId: string, ids: string[], action: BulkAction): Promise<void> {
  if (ids.length === 0) return;
  const set: Record<Exclude<BulkAction, "unsubscribe">, Prisma.Sql> = {
    read: Prisma.sql`"read" = true`,
    unread: Prisma.sql`"read" = false`,
    done: Prisma.sql`"done" = true, "read" = true`,
    undone: Prisma.sql`"done" = false`,
    save: Prisma.sql`"saved" = true`,
    unsave: Prisma.sql`"saved" = false`,
  };
  if (action === "unsubscribe") {
    const rows = await prisma.notification.findMany({ where: { id: { in: ids }, userId }, select: { subjectId: true } });
    await prisma.$transaction([
      ...rows.map((r) =>
        prisma.threadMute.upsert({
          where: { userId_subjectId: { userId, subjectId: r.subjectId } },
          create: { userId, subjectId: r.subjectId },
          update: {},
        }),
      ),
    ]);
    return applyAction(userId, ids, "done");
  }
  await prisma.$executeRaw`UPDATE "Notification" SET ${set[action]} WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})`;
}

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
  // GET /notifications?view=inbox|saved|done&reason=&repo=owner/name&unread=true
  // Without `view` (the header's bell): unread notifications in the inbox, or the
  // whole inbox with all=true.
  app.get("/notifications", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const q = request.query as { all?: string; view?: string; reason?: string; repo?: string; unread?: string; sort?: string };
    const view = q.view === "saved" || q.view === "done" ? q.view : "inbox";
    const base: Prisma.NotificationWhereInput = {
      userId,
      ...(view === "saved" ? { saved: true } : view === "done" ? { done: true } : { done: false }),
      ...((q.view === undefined ? q.all !== "true" : q.unread === "true") ? { read: false } : {}),
    };
    if (q.reason && !REASON_FILTERS[q.reason]) return reply.status(400).send({ error: `Unknown reason ${q.reason}` });
    const where: Prisma.NotificationWhereInput = { ...base, ...(q.reason ? { reason: REASON_FILTERS[q.reason] } : {}) };
    if (q.repo) {
      const [h, n] = q.repo.split("/");
      if (!h || !n) return reply.status(400).send({ error: "repo must be owner/name" });
      where.repo = repoByOwningHandleWhere(h, n);
    }

    const [rows, byRepo] = await Promise.all([
      prisma.notification.findMany({ where, include: notifInclude, orderBy: { updatedAt: q.sort === "oldest" ? "asc" : "desc" }, take: 300 }),
      // The sidebar's repositories: everything in this view, whatever the other filters.
      prisma.notification.groupBy({ by: ["repoId"], where: base, _count: { _all: true } }),
    ]);
    const [subjects, repoNames] = await Promise.all([
      resolveSubjects(rows),
      byRepo.length
        ? prisma.repo.findMany({ where: { id: { in: byRepo.map((r) => r.repoId) } }, select: { id: true, ...notifInclude.repo.select } })
        : [],
    ]);
    const fullName = new Map(repoNames.map((r) => [r.id, `${r.org?.handle ?? r.owner.handle}/${r.name}`]));
    return {
      notifications: rows.map((n) => formatNotification(n, subjects.get(n.subjectId))),
      repos: byRepo
        .map((r) => ({ repo: fullName.get(r.repoId) ?? "", count: r._count._all }))
        .filter((r) => r.repo)
        .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo)),
    };
  });

  // PATCH /notifications — mark the whole inbox read.
  app.patch("/notifications", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    await prisma.$executeRaw`UPDATE "Notification" SET "read" = true WHERE "userId" = ${userId} AND "read" = false AND "done" = false`;
    return reply.status(204).send();
  });

  // POST /notifications/bulk { ids, action } — read, unread, done, undone, save, unsave, unsubscribe.
  app.post("/notifications/bulk", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { ids, action } = (request.body ?? {}) as { ids?: unknown; action?: unknown };
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((i) => typeof i === "string")) {
      return reply.status(400).send({ error: "ids must be a list of notification ids" });
    }
    if (!BULK_ACTIONS.includes(action as BulkAction)) return reply.status(400).send({ error: `action must be one of ${BULK_ACTIONS.join(", ")}` });
    await applyAction(request.user.sub, ids as string[], action as BulkAction);
    return reply.status(204).send();
  });

  // PATCH /notifications/:id { read?, saved?, done? } — with no body, mark it read.
  app.patch("/notifications/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const body = (request.body ?? {}) as { read?: unknown; saved?: unknown; done?: unknown };

    const notif = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
    if (!notif) return reply.status(404).send({ error: "Notification not found" });

    const actions: BulkAction[] = [];
    if (body.read === undefined && body.saved === undefined && body.done === undefined) actions.push("read");
    if (typeof body.read === "boolean") actions.push(body.read ? "read" : "unread");
    if (typeof body.saved === "boolean") actions.push(body.saved ? "save" : "unsave");
    if (typeof body.done === "boolean") actions.push(body.done ? "done" : "undone");
    for (const a of actions) await applyAction(userId, [id], a);

    const updated = await prisma.notification.findUniqueOrThrow({ where: { id }, include: notifInclude });
    return formatNotification(updated, (await resolveSubjects([updated])).get(updated.subjectId));
  });

  // POST /notifications/:id/unsubscribe — stop this conversation's watching and
  // comment notifications (mentions still come), and mark it done. DELETE resubscribes.
  app.post("/notifications/:id/unsubscribe", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const notif = await prisma.notification.findFirst({ where: { id, userId: request.user.sub }, select: { id: true } });
    if (!notif) return reply.status(404).send({ error: "Notification not found" });
    await applyAction(request.user.sub, [id], "unsubscribe");
    return reply.status(204).send();
  });

  app.delete("/notifications/:id/unsubscribe", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const notif = await prisma.notification.findFirst({ where: { id, userId }, select: { subjectId: true } });
    if (!notif) return reply.status(404).send({ error: "Notification not found" });
    await prisma.threadMute.deleteMany({ where: { userId, subjectId: notif.subjectId } });
    return reply.status(204).send();
  });

  // GET /user/subscriptions — the conversations reaching your inbox (#258), and
  // the ones you unsubscribed from. ForgeHub subscribes you by taking part
  // (authoring, commenting, being mentioned, assigned or asked to review), so
  // a conversation that has notified you is one you're subscribed to.
  app.get("/user/subscriptions", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const [rows, mutes] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, include: notifInclude, orderBy: { updatedAt: "desc" }, take: 300 }),
      prisma.threadMute.findMany({ where: { userId }, select: { subjectId: true } }),
    ]);
    const muted = new Set(mutes.map((m) => m.subjectId));
    const subjects = await resolveSubjects(rows);
    const all = rows.map((n) => ({ ...formatNotification(n, subjects.get(n.subjectId)), subscribed: !muted.has(n.subjectId) }));
    return { subscriptions: all.filter((n) => n.subscribed), unsubscribed: all.filter((n) => !n.subscribed) };
  });

  // GET /user/watching — the repositories whose activity reaches you: an explicit
  // watch (any level), or one you own or collaborate on (watched by default).
  app.get("/user/watching", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const [watches, implicit] = await Promise.all([
      prisma.watch.findMany({
        where: { userId },
        select: { level: true, repo: { select: { id: true, visibility: true, ownerId: true, archivedAt: true, ...notifInclude.repo.select, ...repoAccessInclude } } },
      }),
      prisma.repo.findMany({
        where: { OR: [{ ownerId: userId, orgId: null }, { collaborators: { some: { userId } } }], watches: { none: { userId } } },
        select: { id: true, ...notifInclude.repo.select },
      }),
    ]);
    const name = (r: { name: string; owner: { handle: string }; org: { handle: string } | null }) => `${r.org?.handle ?? r.owner.handle}/${r.name}`;
    const repos = [
      ...watches.filter((w) => canRead(w.repo, userId)).map((w) => ({ repo: name(w.repo), level: w.level.toLowerCase(), explicit: true })),
      ...implicit.map((r) => ({ repo: name(r), level: "all", explicit: false })),
    ].sort((a, b) => a.repo.localeCompare(b.repo));
    return { repos };
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
      where: { userId, repoId: repo.id, done: false, ...(all === "true" ? {} : { read: false }) },
      include: notifInclude,
      orderBy: { updatedAt: "desc" },
    });
    const subjects = await resolveSubjects(notifications);
    return { notifications: notifications.map((n) => formatNotification(n, subjects.get(n.subjectId))) };
  });
}
