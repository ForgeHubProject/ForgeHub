import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What a blocked user can't do in their blocker's personal repositories (#258). */
const GUARDED = /^\/repos\/:handle\/:name\/(issues|pulls|reactions)(\/|$)/;

/** Whether `blockerId` has blocked `blockedId`. */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  if (blockerId === blockedId) return false;
  const row = await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId, blockedId } }, select: { blockerId: true } });
  return !!row;
}

/**
 * Blocked users (#258): someone you blocked can't open issues or pull
 * requests, comment, review or react in your personal repositories. Added to
 * each matching route after its own preHandlers, so the caller is known.
 * Must be registered before the routes.
 */
export function registerBlockGuard(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some((m) => WRITES.has(m)) || !GUARDED.test(route.url)) return;
    const existing = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [...existing, blockGuard];
  });
}

async function blockGuard(request: FastifyRequest, reply: FastifyReply) {
  const userId = (request as { user?: { sub?: string } }).user?.sub;
  const { handle, name } = request.params as { handle?: string; name?: string };
  if (!userId || !handle || !name) return;
  // One lookup: a block on the caller by the user whose personal repository this is.
  let blocked: unknown = null;
  try {
    blocked = await prisma.block.findFirst({
      where: {
        blockedId: userId,
        blocker: { handle: handle.toLowerCase(), id: { not: userId }, repos: { some: { name: name.toLowerCase(), orgId: null } } },
      },
      select: { blockerId: true },
    });
  } catch {
    return; // the route reads the repo itself
  }
  if (blocked) return reply.status(403).send({ error: "You can't do that in this repository." });
}
