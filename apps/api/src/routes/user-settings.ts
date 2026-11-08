import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { reasonPrefs, type NotificationReason } from "../notifications-service.js";

const REASONS: NotificationReason[] = ["SUBSCRIBED", "COMMENT", "MENTIONED", "TEAM_MENTIONED", "ASSIGNED", "REVIEW_REQUESTED"];
const MAX_REPLIES = 100;
const MAX_REPLY_BODY = 65_536;

const personCard = { handle: true, displayName: true, avatarKey: true } as const;

/**
 * Settings (#258): notification preferences per reason, saved replies, and
 * blocked users.
 */
export async function userSettingsRoutes(app: FastifyInstance) {
  // ── Notification preferences ───────────────────────────────────────────────
  app.get("/user/notification-preferences", { preHandler: [app.authenticate] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.sub },
      select: { emailNotifications: true, notificationPrefs: true },
    });
    return {
      emailNotifications: user.emailNotifications,
      reasons: Object.fromEntries(REASONS.map((r) => [r, reasonPrefs(user.notificationPrefs, r)])),
    };
  });

  // PUT { emailNotifications?, reasons?: { [reason]: { web?, email? } } } — merged into what's stored.
  app.put("/user/notification-preferences", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { emailNotifications, reasons } = (request.body ?? {}) as { emailNotifications?: unknown; reasons?: unknown };
    if (emailNotifications !== undefined && typeof emailNotifications !== "boolean") {
      return reply.status(400).send({ error: "emailNotifications must be true or false" });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub }, select: { notificationPrefs: true } });
    const next = Object.fromEntries(REASONS.map((r) => [r, reasonPrefs(user.notificationPrefs, r)]));
    if (reasons !== undefined) {
      if (!reasons || typeof reasons !== "object") return reply.status(400).send({ error: "reasons must be an object" });
      for (const [reason, value] of Object.entries(reasons)) {
        if (!REASONS.includes(reason as NotificationReason)) return reply.status(400).send({ error: `Unknown reason ${reason}` });
        const v = value as { web?: unknown; email?: unknown };
        for (const k of ["web", "email"] as const) {
          if (v?.[k] === undefined) continue;
          if (typeof v[k] !== "boolean") return reply.status(400).send({ error: `${reason}.${k} must be true or false` });
          next[reason][k] = v[k] as boolean;
        }
      }
    }
    const saved = await prisma.user.update({
      where: { id: request.user.sub },
      data: { notificationPrefs: JSON.stringify(next), ...(emailNotifications !== undefined ? { emailNotifications } : {}) },
      select: { emailNotifications: true },
    });
    return { emailNotifications: saved.emailNotifications, reasons: next };
  });

  // ── Saved replies ──────────────────────────────────────────────────────────
  app.get("/user/replies", { preHandler: [app.authenticate] }, async (request) => {
    const replies = await prisma.savedReply.findMany({
      where: { userId: request.user.sub },
      orderBy: { title: "asc" },
      select: { id: true, title: true, body: true, updatedAt: true },
    });
    return { replies };
  });

  const replyFields = (body: unknown): { title: string; body: string } | string => {
    const { title, body: text } = (body ?? {}) as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || !title.trim() || title.trim().length > 100) return "A title of up to 100 characters is required";
    if (typeof text !== "string" || !text.trim() || text.length > MAX_REPLY_BODY) return "The reply can't be empty";
    return { title: title.trim(), body: text };
  };

  app.post("/user/replies", { preHandler: [app.authenticate] }, async (request, reply) => {
    const fields = replyFields(request.body);
    if (typeof fields === "string") return reply.status(400).send({ error: fields });
    const count = await prisma.savedReply.count({ where: { userId: request.user.sub } });
    if (count >= MAX_REPLIES) return reply.status(400).send({ error: `You can keep up to ${MAX_REPLIES} saved replies` });
    const saved = await prisma.savedReply.create({
      data: { userId: request.user.sub, ...fields },
      select: { id: true, title: true, body: true, updatedAt: true },
    });
    return reply.status(201).send(saved);
  });

  app.patch("/user/replies/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const fields = replyFields(request.body);
    if (typeof fields === "string") return reply.status(400).send({ error: fields });
    const { id } = request.params as { id: string };
    const { count } = await prisma.savedReply.updateMany({ where: { id, userId: request.user.sub }, data: fields });
    if (count === 0) return reply.status(404).send({ error: "Saved reply not found" });
    return prisma.savedReply.findUniqueOrThrow({ where: { id }, select: { id: true, title: true, body: true, updatedAt: true } });
  });

  app.delete("/user/replies/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { count } = await prisma.savedReply.deleteMany({ where: { id, userId: request.user.sub } });
    if (count === 0) return reply.status(404).send({ error: "Saved reply not found" });
    return reply.status(204).send();
  });

  // ── Blocked users ──────────────────────────────────────────────────────────
  app.get("/user/blocks", { preHandler: [app.authenticate] }, async (request) => {
    const rows = await prisma.block.findMany({
      where: { blockerId: request.user.sub },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, blocked: { select: personCard } },
    });
    return { users: rows.map((r) => ({ ...r.blocked, blockedAt: r.createdAt.toISOString() })) };
  });

  // PUT /user/blocks/:handle — block someone: follows between you end, and
  // they stop being a collaborator on your personal repositories, as on GitHub.
  app.put("/user/blocks/:handle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const me = request.user.sub;
    const target = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true } });
    if (!target) return reply.status(404).send({ error: "User not found" });
    if (target.id === me) return reply.status(400).send({ error: "You can't block yourself" });
    await prisma.$transaction([
      prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId: me, blockedId: target.id } },
        create: { blockerId: me, blockedId: target.id },
        update: {},
      }),
      prisma.follow.deleteMany({
        where: { OR: [{ followerId: me, followingId: target.id }, { followerId: target.id, followingId: me }] },
      }),
      prisma.repoCollaborator.deleteMany({ where: { userId: target.id, repo: { ownerId: me, orgId: null } } }),
    ]);
    return { blocked: true };
  });

  app.delete("/user/blocks/:handle", { preHandler: [app.authenticate] }, async (request, reply) => {
    const target = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true } });
    if (!target) return reply.status(404).send({ error: "User not found" });
    await prisma.block.deleteMany({ where: { blockerId: request.user.sub, blockedId: target.id } });
    return { blocked: false };
  });
}
