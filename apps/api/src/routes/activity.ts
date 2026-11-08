import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, resolveRepo } from "../repo-access.js";
import { git } from "../git-utils.js";
import { REF_KINDS, type RefKind } from "../activity-log.js";

const PER_PAGE = 30;

/**
 * A repository's Activity (#256): what happened to its branches, newest first,
 * by branch, kind and actor: GitHub's /activity page.
 */
export async function activityRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/activity?branch=&kind=&actor=&before=<iso>
  app.get("/repos/:handle/:name/activity", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const viewer = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, viewer)) return reply.status(404).send({ error: "Not found" });

    const q = request.query as { branch?: string; kind?: string; actor?: string; before?: string };
    if (q.kind && !REF_KINDS.includes(q.kind as RefKind)) return reply.status(400).send({ error: `kind must be one of ${REF_KINDS.join(", ")}` });
    let actorId: string | undefined;
    if (q.actor) {
      const user = await prisma.user.findUnique({ where: { handle: q.actor.toLowerCase() }, select: { id: true } });
      if (!user) return { events: [], next: null };
      actorId = user.id;
    }
    const before = q.before ? new Date(q.before) : null;
    const rows = await prisma.refUpdate.findMany({
      where: {
        repoId: repo.id,
        ...(q.branch ? { ref: q.branch } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(actorId ? { actorId } : {}),
        ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PER_PAGE + 1,
    });
    const page = rows.slice(0, PER_PAGE);

    const actorIds = [...new Set(page.map((r) => r.actorId).filter((id): id is string => !!id))];
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, handle: true, displayName: true, avatarKey: true } })
      : [];
    const byId = new Map(actors.map((a) => [a.id, { handle: a.handle, displayName: a.displayName, avatarKey: a.avatarKey }]));

    const events = await Promise.all(
      page.map(async (r) => ({
        id: r.id,
        ref: r.ref,
        kind: r.kind,
        beforeSha: r.beforeSha,
        afterSha: r.afterSha,
        prNumber: r.prNumber,
        actor: (r.actorId && byId.get(r.actorId)) || null,
        // How many commits a push added; null when history no longer has them.
        commits: r.kind === "push" && r.beforeSha && r.afterSha && repo.storageKey
          ? await git(repo.storageKey, ["rev-list", "--count", `${r.beforeSha}..${r.afterSha}`]).then((n) => Number(n.trim())).catch(() => null)
          : null,
        createdAt: r.createdAt.toISOString(),
      })),
    );
    return { events, next: rows.length > PER_PAGE ? page[page.length - 1].createdAt.toISOString() : null };
  });
}
