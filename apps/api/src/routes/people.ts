import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude } from "../repo-access.js";
import { repoCardInclude, repoResponse } from "./repos.js";
import { isBlocked } from "../blocks.js";

/** GitHub's limit on pinned repositories. */
const MAX_PINS = 6;

const userCard = { select: { handle: true, displayName: true, avatarKey: true, bio: true } } as const;

/** A private profile (#257) shows its followers and following to its owner only. */
const hidden = (user: { id: string; privateProfile: boolean }, request: object) =>
  user.privateProfile && (request as { user?: { sub: string } }).user?.sub !== user.id;

/**
 * People on profiles (#257): pinned repositories, and following. Pins only
 * ever show repositories the viewer can read.
 */
export async function peopleRoutes(app: FastifyInstance) {
  // GET /users/:handle/pins — the pinned repositories, in order.
  app.get("/users/:handle/pins", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const viewer = (request as { user?: { sub: string } }).user?.sub;
    const user = await prisma.user.findUnique({ where: { handle: handle.toLowerCase() }, select: { id: true } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    const pins = await prisma.profilePin.findMany({
      where: { userId: user.id },
      orderBy: { position: "asc" },
      include: { repo: { include: { ...repoCardInclude, ...repoAccessInclude } } },
    });
    return { repos: pins.filter((p) => canRead(p.repo, viewer)).map((p) => repoResponse(p.repo)) };
  });

  // PUT /users/me/pins { repoIds } — replace the pins (up to six, each a repo the caller can read).
  app.put("/users/me/pins", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const { repoIds } = request.body as { repoIds?: unknown };
    if (!Array.isArray(repoIds) || repoIds.some((id) => typeof id !== "string") || new Set(repoIds).size !== repoIds.length) {
      return reply.status(400).send({ error: "repoIds must be a list of distinct repository ids" });
    }
    if (repoIds.length > MAX_PINS) return reply.status(400).send({ error: `At most ${MAX_PINS} repositories can be pinned` });
    const repos = await prisma.repo.findMany({ where: { id: { in: repoIds as string[] } }, include: repoAccessInclude });
    if (repos.length !== repoIds.length || !repos.every((r) => canRead(r, userId))) {
      return reply.status(404).send({ error: "Repository not found" });
    }
    await prisma.$transaction([
      prisma.profilePin.deleteMany({ where: { userId } }),
      ...(repoIds as string[]).map((repoId, position) => prisma.profilePin.create({ data: { userId, repoId, position } })),
    ]);
    return { repoIds };
  });

  // PUT /users/:handle/follow and DELETE — follow or unfollow someone.
  app.put("/users/:handle/follow", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const target = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true } });
    if (!target) return reply.status(404).send({ error: "User not found" });
    if (target.id === userId) return reply.status(400).send({ error: "You can't follow yourself" });
    // Blocked (#258), either way round: no following.
    if ((await isBlocked(target.id, userId)) || (await isBlocked(userId, target.id))) {
      return reply.status(403).send({ error: "You can't follow this user" });
    }
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId: userId, followingId: target.id } },
      create: { followerId: userId, followingId: target.id },
      update: {},
    });
    return { following: true, followers: await prisma.follow.count({ where: { followingId: target.id } }) };
  });

  app.delete("/users/:handle/follow", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    const target = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true } });
    if (!target) return reply.status(404).send({ error: "User not found" });
    await prisma.follow.deleteMany({ where: { followerId: userId, followingId: target.id } });
    return { following: false, followers: await prisma.follow.count({ where: { followingId: target.id } }) };
  });

  // GET /users/:handle/followers and /following — newest first.
  app.get("/users/:handle/followers", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true, privateProfile: true } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    if (hidden(user, request)) return { users: [], private: true };
    const rows = await prisma.follow.findMany({
      where: { followingId: user.id }, orderBy: { createdAt: "desc" }, take: 200, include: { follower: userCard },
    });
    return { users: rows.map((r) => r.follower) };
  });

  app.get("/users/:handle/following", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { handle: (request.params as { handle: string }).handle.toLowerCase() }, select: { id: true, privateProfile: true } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    if (hidden(user, request)) return { users: [], private: true };
    const rows = await prisma.follow.findMany({
      where: { followerId: user.id }, orderBy: { createdAt: "desc" }, take: 200, include: { following: userCard },
    });
    return { users: rows.map((r) => r.following) };
  });
}
