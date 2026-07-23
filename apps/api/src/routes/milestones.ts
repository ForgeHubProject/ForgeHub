import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

/**
 * Milestones (issue #83) — the lightest-weight planning primitive. CRUD mirrors
 * `routes/labels.ts` (label-style writer gate to mutate), but keyed by a per-repo
 * `number` so URLs read `…/milestones/3`. Progress is the count of closed vs total
 * associated issues + PRs, computed on read (no denormalized counters at this
 * scale). Deleting a milestone nulls out associations via the schema's SetNull —
 * it never deletes the items.
 */

/** A PR counts as "closed" for progress once it is MERGED or CLOSED. */
type ItemState = { state: string };

function progressOf(items: ItemState[]) {
  let closed = 0;
  for (const it of items) if (it.state !== "OPEN") closed += 1;
  const total = items.length;
  const open = total - closed;
  const percent = total === 0 ? 0 : Math.round((closed / total) * 100);
  return { openItems: open, closedItems: closed, totalItems: total, percent };
}

type MilestoneRow = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  dueOn: Date | null;
  state: string;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function formatMilestone(m: MilestoneRow, progress: ReturnType<typeof progressOf>) {
  return {
    id: m.id,
    number: m.number,
    title: m.title,
    description: m.description,
    dueOn: m.dueOn ? m.dueOn.toISOString() : null,
    state: m.state.toLowerCase(),
    closedAt: m.closedAt ? m.closedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    ...progress,
  };
}

/** Parse a `dueOn` input (ISO date/datetime string, or null/"" to clear). Returns
 * `undefined` when the field was absent, `null` to clear, or a Date. Throws on bad
 * input so the caller can 400. */
function parseDueOn(raw: unknown): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("dueOn must be an ISO date string");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error("dueOn must be a valid date");
  return d;
}

export async function milestoneRoutes(app: FastifyInstance) {
  // A PAT must carry `repo:write` to mutate; session/JWT auth is unscoped and
  // no-ops this guard (issue #87). The route bodies keep their own canWrite check.
  const write = app.requireScope("repo:write");

  // GET /repos/:handle/:name/milestones
  // Returns every milestone (client filters by the open/closed toggle) with its
  // progress, plus repo-wide open/closed milestone counts for the toggle.
  app.get("/repos/:handle/:name/milestones", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { state } = request.query as { state?: string };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const stateFilter =
      state === "closed" ? "CLOSED"
      : state === "open" ? "OPEN"
      : undefined; // default: all

    const [milestonesRaw, issues, pulls] = await Promise.all([
      prisma.milestone.findMany({
        where: { repoId: repo.id, ...(stateFilter ? { state: stateFilter } : {}) },
      }),
      prisma.issue.findMany({
        where: { repoId: repo.id, milestoneId: { not: null } },
        select: { milestoneId: true, state: true },
      }),
      prisma.pullRequest.findMany({
        where: { repoId: repo.id, milestoneId: { not: null } },
        select: { milestoneId: true, state: true },
      }),
    ]);

    // GitHub-style ordering: open milestones before closed, then soonest due date
    // first with undated milestones last, then creation order as the tiebreaker.
    const milestones = [...milestonesRaw].sort((a, b) => {
      if (a.state !== b.state) return a.state === "OPEN" ? -1 : 1;
      const ad = a.dueOn ? a.dueOn.getTime() : Number.POSITIVE_INFINITY;
      const bd = b.dueOn ? b.dueOn.getTime() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Bucket associated items by milestone id, then compute progress per milestone.
    const byMilestone = new Map<string, ItemState[]>();
    for (const it of [...issues, ...pulls]) {
      if (!it.milestoneId) continue;
      const bucket = byMilestone.get(it.milestoneId) ?? [];
      bucket.push({ state: it.state });
      byMilestone.set(it.milestoneId, bucket);
    }

    // Repo-wide milestone counts (independent of the state filter) so the UI toggle
    // can show both numbers even when the list itself is filtered.
    const [openCount, closedCount] = await Promise.all([
      prisma.milestone.count({ where: { repoId: repo.id, state: "OPEN" } }),
      prisma.milestone.count({ where: { repoId: repo.id, state: "CLOSED" } }),
    ]);

    return {
      milestones: milestones.map((m) => formatMilestone(m, progressOf(byMilestone.get(m.id) ?? []))),
      counts: { open: openCount, closed: closedCount },
    };
  });

  // POST /repos/:handle/:name/milestones — writer-gated create.
  app.post("/repos/:handle/:name/milestones", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const { title, description, dueOn, state } = request.body as {
      title?: string; description?: string; dueOn?: string | null; state?: string;
    };

    if (!title || title.trim().length === 0 || title.trim().length > 255) {
      return reply.status(400).send({ error: "title is required (1–255 characters)" });
    }
    let due: Date | null | undefined;
    try { due = parseDueOn(dueOn); } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : "Invalid dueOn" });
    }

    const existing = await prisma.milestone.findFirst({ where: { repoId: repo.id, title: title.trim() } });
    if (existing) return reply.status(409).send({ error: "A milestone with this title already exists in the repository" });

    const wantClosed = state === "closed";

    const milestone = await prisma.$transaction(async (tx) => {
      const top = await tx.milestone.findFirst({
        where: { repoId: repo.id }, orderBy: { number: "desc" }, select: { number: true },
      });
      return tx.milestone.create({
        data: {
          repoId: repo.id,
          number: (top?.number ?? 0) + 1,
          title: title.trim(),
          description: description?.trim() || null,
          dueOn: due ?? null,
          state: wantClosed ? "CLOSED" : "OPEN",
          closedAt: wantClosed ? new Date() : null,
        },
      });
    });

    return reply.status(201).send(formatMilestone(milestone, progressOf([])));
  });

  // GET /repos/:handle/:name/milestones/:number — detail with progress.
  app.get("/repos/:handle/:name/milestones/:number", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const milestone = await prisma.milestone.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!milestone) return reply.status(404).send({ error: "Milestone not found" });

    const [issues, pulls] = await Promise.all([
      prisma.issue.findMany({ where: { repoId: repo.id, milestoneId: milestone.id }, select: { state: true } }),
      prisma.pullRequest.findMany({ where: { repoId: repo.id, milestoneId: milestone.id }, select: { state: true } }),
    ]);

    return formatMilestone(milestone, progressOf([...issues, ...pulls]));
  });

  // PATCH /repos/:handle/:name/milestones/:number — writer-gated update.
  app.patch("/repos/:handle/:name/milestones/:number", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const milestone = await prisma.milestone.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!milestone) return reply.status(404).send({ error: "Milestone not found" });

    const { title, description, dueOn, state } = request.body as {
      title?: string; description?: string; dueOn?: string | null; state?: string;
    };

    if (title !== undefined && (title.trim().length === 0 || title.trim().length > 255)) {
      return reply.status(400).send({ error: "title must be 1–255 characters" });
    }
    if (state !== undefined && !["open", "closed"].includes(state)) {
      return reply.status(400).send({ error: "state must be 'open' or 'closed'" });
    }
    let due: Date | null | undefined;
    try { due = parseDueOn(dueOn); } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : "Invalid dueOn" });
    }

    // Renaming into another milestone's title is a conflict.
    if (title !== undefined && title.trim() !== milestone.title) {
      const clash = await prisma.milestone.findFirst({ where: { repoId: repo.id, title: title.trim() } });
      if (clash) return reply.status(409).send({ error: "A milestone with this title already exists in the repository" });
    }

    const updated = await prisma.milestone.update({
      where: { id: milestone.id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description: description.trim() || null } : {}),
        ...(due !== undefined ? { dueOn: due } : {}),
        ...(state === "closed" && milestone.state !== "CLOSED" ? { state: "CLOSED", closedAt: new Date() } : {}),
        ...(state === "open" && milestone.state !== "OPEN" ? { state: "OPEN", closedAt: null } : {}),
      },
    });

    const [issues, pulls] = await Promise.all([
      prisma.issue.findMany({ where: { repoId: repo.id, milestoneId: milestone.id }, select: { state: true } }),
      prisma.pullRequest.findMany({ where: { repoId: repo.id, milestoneId: milestone.id }, select: { state: true } }),
    ]);

    return formatMilestone(updated, progressOf([...issues, ...pulls]));
  });

  // DELETE /repos/:handle/:name/milestones/:number — writer-gated. SetNull on the
  // schema clears associations; the issues/PRs themselves are untouched.
  app.delete("/repos/:handle/:name/milestones/:number", { preHandler: [app.authenticate, write] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const milestone = await prisma.milestone.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!milestone) return reply.status(404).send({ error: "Milestone not found" });

    await prisma.milestone.delete({ where: { id: milestone.id } });

    return reply.status(204).send();
  });
}
