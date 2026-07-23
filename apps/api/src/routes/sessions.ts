import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";

/**
 * Interactive-login session management (issue #117).
 *
 * Brings interactive logins to parity with the PAT listing (`routes/tokens.ts`):
 * a user can see every active login (device / UA, when it started, last seen) and
 * revoke one ("sign out this device") or all-but-current ("sign out everywhere").
 * Revoked sessions are rejected by the auth preHandler on their next request.
 */

type SessionRow = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

function publicSession(s: SessionRow, currentSid: string | undefined) {
  return {
    id: s.id,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    current: s.id === currentSid,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  // GET /auth/sessions — the caller's active (non-revoked) logins, current flagged.
  app.get("/auth/sessions", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const currentSid = request.user.sid;
    const sessions = await prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
    });
    return { sessions: sessions.map((s) => publicSession(s, currentSid)) };
  });

  // DELETE /auth/sessions/:id — revoke one login ("sign out this device").
  app.delete("/auth/sessions/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const { id } = request.params as { id: string };
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: "Session not found" });
    }
    if (!session.revokedAt) {
      await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
    }
    return reply.status(204).send();
  });

  // DELETE /auth/sessions — revoke every other active login ("sign out everywhere").
  // The current session is spared so the caller stays signed in. A caller whose
  // token predates sessions (no `sid`) simply revokes all of their sessions.
  app.delete("/auth/sessions", { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;
    const currentSid = request.user.sid;
    const result = await prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentSid ? { id: { not: currentSid } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  });
}
