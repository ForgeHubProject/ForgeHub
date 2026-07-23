/**
 * Repo-level Projects (issue #84): a classic-style board + table over the repo's
 * issues and PRs. A project owns ordered status columns (seeded Todo / In
 * progress / Done); each column holds items that reference an issue or PR by
 * number. The subject reference is polymorphic (subjectType + subjectNumber) and
 * hydrated at read time by joining on (repoId, number), so an item degrades
 * gracefully (subject: null) if its issue/PR is later deleted.
 *
 * Ordering is deterministic renumber-on-write: positions within a column are
 * always the dense sequence 0,1,2,… An index-based move recomputes them, so an
 * optimistic client (which inserts at the same index) and the server always
 * agree without any fractional-key drift.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";

/** The columns every new project is seeded with, in order. */
const DEFAULT_COLUMNS = ["Todo", "In progress", "Done"] as const;

type SubjectApiType = "issue" | "pull";
const toEnum = (t: SubjectApiType) => (t === "issue" ? "ISSUE" : "PULL_REQUEST");
const toApiType = (t: string): SubjectApiType => (t === "ISSUE" ? "issue" : "pull");

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatSummary(p: {
  id: string;
  number: number;
  name: string;
  description: string | null;
  closed: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { items: number; columns: number };
}) {
  return {
    id: p.id,
    number: p.number,
    name: p.name,
    description: p.description,
    closed: p.closed,
    itemCount: p._count?.items ?? 0,
    columnCount: p._count?.columns ?? 0,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

type RawItem = {
  id: string;
  columnId: string;
  position: number;
  subjectType: string;
  subjectNumber: number;
  createdAt: Date;
};

type HydratedSubject = {
  type: SubjectApiType;
  number: number;
  title: string;
  state: string;
  labels: Array<{ id: string; name: string; color: string }>;
  assignee: string | null;
} | null;

/**
 * Batch-load the issues/PRs referenced by a project's items and return a lookup
 * for building each item's hydrated subject. Issues carry labels + assignee;
 * PRs in this codebase have neither, so those come back empty.
 */
async function hydrate(repoId: string, items: RawItem[]) {
  const issueNumbers = items.filter((i) => i.subjectType === "ISSUE").map((i) => i.subjectNumber);
  const prNumbers = items.filter((i) => i.subjectType === "PULL_REQUEST").map((i) => i.subjectNumber);

  const [issues, pulls] = await Promise.all([
    issueNumbers.length
      ? prisma.issue.findMany({
          where: { repoId, number: { in: issueNumbers } },
          select: {
            number: true,
            title: true,
            state: true,
            assignee: { select: { handle: true } },
            labels: { include: { label: { select: { id: true, name: true, color: true } } } },
          },
        })
      : Promise.resolve([]),
    prNumbers.length
      ? prisma.pullRequest.findMany({
          where: { repoId, number: { in: prNumbers } },
          select: { number: true, title: true, state: true },
        })
      : Promise.resolve([]),
  ]);

  const issueByNum = new Map(issues.map((i) => [i.number, i]));
  const prByNum = new Map(pulls.map((p) => [p.number, p]));

  return function subjectFor(item: RawItem): HydratedSubject {
    if (item.subjectType === "ISSUE") {
      const iss = issueByNum.get(item.subjectNumber);
      if (!iss) return null;
      return {
        type: "issue",
        number: iss.number,
        title: iss.title,
        state: iss.state.toLowerCase(),
        labels: iss.labels.map((il) => ({ id: il.label.id, name: il.label.name, color: il.label.color })),
        assignee: iss.assignee?.handle ?? null,
      };
    }
    const pr = prByNum.get(item.subjectNumber);
    if (!pr) return null;
    return {
      type: "pull",
      number: pr.number,
      title: pr.title,
      state: pr.state.toLowerCase(),
      labels: [],
      assignee: null,
    };
  };
}

function formatItem(item: RawItem, subject: HydratedSubject) {
  return {
    id: item.id,
    columnId: item.columnId,
    position: item.position,
    subjectType: toApiType(item.subjectType),
    subjectNumber: item.subjectNumber,
    subject,
    createdAt: item.createdAt.toISOString(),
  };
}

/** Load a project's full board: ordered columns, each with ordered hydrated items. */
async function loadDetail(repoId: string, project: {
  id: string;
  number: number;
  name: string;
  description: string | null;
  closed: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  const [columns, items] = await Promise.all([
    prisma.projectColumn.findMany({ where: { projectId: project.id }, orderBy: { position: "asc" } }),
    prisma.projectItem.findMany({ where: { projectId: project.id }, orderBy: { position: "asc" } }),
  ]);
  const subjectFor = await hydrate(repoId, items);
  const itemsByColumn = new Map<string, ReturnType<typeof formatItem>[]>();
  for (const it of items) {
    const arr = itemsByColumn.get(it.columnId) ?? [];
    arr.push(formatItem(it, subjectFor(it)));
    itemsByColumn.set(it.columnId, arr);
  }
  return {
    id: project.id,
    number: project.number,
    name: project.name,
    description: project.description,
    closed: project.closed,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    columns: columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      items: itemsByColumn.get(c.id) ?? [],
    })),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function projectRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/projects?state=open|closed|all
  app.get("/repos/:handle/:name/projects", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const { state = "open" } = request.query as { state?: string };

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const closedFilter = state === "closed" ? true : state === "all" ? undefined : false;

    const projects = await prisma.project.findMany({
      where: { repoId: repo.id, ...(closedFilter === undefined ? {} : { closed: closedFilter }) },
      orderBy: { number: "desc" },
      include: { _count: { select: { items: true, columns: true } } },
    });

    return { projects: projects.map(formatSummary) };
  });

  // POST /repos/:handle/:name/projects  { name, description? } — writer, seeds columns.
  app.post("/repos/:handle/:name/projects", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const { name: projectName, description } = request.body as { name?: string; description?: string };
    if (!projectName?.trim() || projectName.trim().length > 100) {
      return reply.status(400).send({ error: "name is required (1–100 characters)" });
    }

    const project = await prisma.$transaction(async (tx) => {
      const count = await tx.project.count({ where: { repoId: repo.id } });
      const created = await tx.project.create({
        data: {
          repoId: repo.id,
          number: count + 1,
          name: projectName.trim(),
          description: description?.trim() || null,
        },
      });
      await tx.projectColumn.createMany({
        data: DEFAULT_COLUMNS.map((columnName, i) => ({ projectId: created.id, name: columnName, position: i })),
      });
      return created;
    });

    return reply.status(201).send(await loadDetail(repo.id, project));
  });

  // GET /repos/:handle/:name/projects/:number — full board.
  app.get("/repos/:handle/:name/projects/:number", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const project = await prisma.project.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!project) return reply.status(404).send({ error: "Project not found" });

    return loadDetail(repo.id, project);
  });

  // PATCH /repos/:handle/:name/projects/:number  { name?, description?, closed? } — writer.
  app.patch("/repos/:handle/:name/projects/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const project = await prisma.project.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const { name: newName, description, closed } = request.body as {
      name?: string;
      description?: string;
      closed?: boolean;
    };
    if (newName !== undefined && (!newName.trim() || newName.trim().length > 100)) {
      return reply.status(400).send({ error: "name must be 1–100 characters" });
    }

    await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(newName !== undefined ? { name: newName.trim() } : {}),
        ...(description !== undefined ? { description: description.trim() || null } : {}),
        ...(closed !== undefined ? { closed: Boolean(closed) } : {}),
      },
    });

    const fresh = await prisma.project.findFirst({ where: { id: project.id } });
    return loadDetail(repo.id, fresh!);
  });

  // DELETE /repos/:handle/:name/projects/:number — writer.
  app.delete("/repos/:handle/:name/projects/:number", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;

    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });

    const project = await prisma.project.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!project) return reply.status(404).send({ error: "Project not found" });

    await prisma.project.delete({ where: { id: project.id } });
    return reply.status(204).send();
  });

  // ─── Columns ────────────────────────────────────────────────────────────────

  /** Resolve repo + project + writer gate for a column/item mutation. */
  async function requireWritableProject(request: FastifyRequest, reply: FastifyReply) {
    const { handle, name, number } = request.params as { handle: string; name: string; number: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) {
      reply.status(404).send({ error: "Not found" });
      return null;
    }
    if (!canWrite(repo, userId)) {
      reply.status(403).send({ error: "Write access required" });
      return null;
    }
    const project = await prisma.project.findFirst({ where: { repoId: repo.id, number: Number(number) } });
    if (!project) {
      reply.status(404).send({ error: "Project not found" });
      return null;
    }
    return { repo, project, userId };
  }

  // POST /repos/:handle/:name/projects/:number/columns  { name } — append.
  app.post("/repos/:handle/:name/projects/:number/columns", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;

    const { name: columnName } = request.body as { name?: string };
    if (!columnName?.trim() || columnName.trim().length > 50) {
      return reply.status(400).send({ error: "name is required (1–50 characters)" });
    }

    const column = await prisma.$transaction(async (tx) => {
      const count = await tx.projectColumn.count({ where: { projectId: ctx.project.id } });
      return tx.projectColumn.create({
        data: { projectId: ctx.project.id, name: columnName.trim(), position: count },
      });
    });

    return reply.status(201).send({ id: column.id, name: column.name, position: column.position, items: [] });
  });

  // PATCH /repos/:handle/:name/projects/:number/columns/:columnId  { name } — rename.
  app.patch("/repos/:handle/:name/projects/:number/columns/:columnId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;
    const { columnId } = request.params as { columnId: string };

    const column = await prisma.projectColumn.findFirst({ where: { id: columnId, projectId: ctx.project.id } });
    if (!column) return reply.status(404).send({ error: "Column not found" });

    const { name: columnName } = request.body as { name?: string };
    if (!columnName?.trim() || columnName.trim().length > 50) {
      return reply.status(400).send({ error: "name is required (1–50 characters)" });
    }

    const updated = await prisma.projectColumn.update({
      where: { id: column.id },
      data: { name: columnName.trim() },
    });
    return { id: updated.id, name: updated.name, position: updated.position };
  });

  // PUT /repos/:handle/:name/projects/:number/columns/order  { order: string[] } — reorder.
  app.put("/repos/:handle/:name/projects/:number/columns/order", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;

    const { order } = request.body as { order?: string[] };
    if (!Array.isArray(order) || order.length === 0) {
      return reply.status(400).send({ error: "order must be a non-empty array of column ids" });
    }

    const columns = await prisma.projectColumn.findMany({ where: { projectId: ctx.project.id } });
    const ids = new Set(columns.map((c) => c.id));
    const orderSet = new Set(order);
    // Must be a permutation of exactly this project's columns.
    if (order.length !== columns.length || orderSet.size !== order.length || !order.every((id) => ids.has(id))) {
      return reply.status(400).send({ error: "order must be a permutation of the project's columns" });
    }

    await prisma.$transaction(
      order.map((id, i) => prisma.projectColumn.update({ where: { id }, data: { position: i } })),
    );

    const fresh = await prisma.projectColumn.findMany({ where: { projectId: ctx.project.id }, orderBy: { position: "asc" } });
    return { columns: fresh.map((c) => ({ id: c.id, name: c.name, position: c.position })) };
  });

  // DELETE /repos/:handle/:name/projects/:number/columns/:columnId — must be empty.
  app.delete("/repos/:handle/:name/projects/:number/columns/:columnId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;
    const { columnId } = request.params as { columnId: string };

    const column = await prisma.projectColumn.findFirst({ where: { id: columnId, projectId: ctx.project.id } });
    if (!column) return reply.status(404).send({ error: "Column not found" });

    const itemCount = await prisma.projectItem.count({ where: { columnId: column.id } });
    if (itemCount > 0) {
      return reply.status(409).send({ error: "Move or remove this column's cards before deleting it" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.projectColumn.delete({ where: { id: column.id } });
      // Renumber the remaining columns densely so positions stay 0,1,2,…
      const rest = await tx.projectColumn.findMany({ where: { projectId: ctx.project.id }, orderBy: { position: "asc" } });
      for (let i = 0; i < rest.length; i++) {
        if (rest[i]!.position !== i) await tx.projectColumn.update({ where: { id: rest[i]!.id }, data: { position: i } });
      }
    });

    return reply.status(204).send();
  });

  // ─── Items ────────────────────────────────────────────────────────────────

  // POST /repos/:handle/:name/projects/:number/items  { columnId, type, number } — add.
  app.post("/repos/:handle/:name/projects/:number/items", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;

    const { columnId, type, number: subjectNumber } = request.body as {
      columnId?: string;
      type?: string;
      number?: number;
    };
    if (type !== "issue" && type !== "pull") {
      return reply.status(400).send({ error: "type must be 'issue' or 'pull'" });
    }
    if (typeof subjectNumber !== "number" || !Number.isInteger(subjectNumber) || subjectNumber < 1) {
      return reply.status(400).send({ error: "number must be a positive integer" });
    }
    if (!columnId) return reply.status(400).send({ error: "columnId is required" });

    const column = await prisma.projectColumn.findFirst({ where: { id: columnId, projectId: ctx.project.id } });
    if (!column) return reply.status(404).send({ error: "Column not found" });

    // The subject must be a real issue/PR in this repo.
    const subjectType = toEnum(type);
    const exists =
      type === "issue"
        ? await prisma.issue.findFirst({ where: { repoId: ctx.repo.id, number: subjectNumber }, select: { id: true } })
        : await prisma.pullRequest.findFirst({ where: { repoId: ctx.repo.id, number: subjectNumber }, select: { id: true } });
    if (!exists) {
      return reply.status(404).send({ error: `${type === "issue" ? "Issue" : "Pull request"} #${subjectNumber} not found` });
    }

    // At most one card per subject per project (across all columns).
    const dup = await prisma.projectItem.findFirst({
      where: { projectId: ctx.project.id, subjectType, subjectNumber },
    });
    if (dup) return reply.status(409).send({ error: "This item is already on the board" });

    const item = await prisma.$transaction(async (tx) => {
      const count = await tx.projectItem.count({ where: { columnId: column.id } });
      return tx.projectItem.create({
        data: {
          projectId: ctx.project.id,
          columnId: column.id,
          subjectType,
          subjectNumber,
          position: count,
          addedById: ctx.userId,
        },
      });
    });

    const subjectFor = await hydrate(ctx.repo.id, [item]);
    return reply.status(201).send(formatItem(item, subjectFor(item)));
  });

  // PATCH /repos/:handle/:name/projects/:number/items/:itemId  { columnId?, position } — move.
  // `position` is the target 0-based index within the destination column. The
  // destination (and the source, when it differs) is renumbered densely.
  app.patch("/repos/:handle/:name/projects/:number/items/:itemId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;
    const { itemId } = request.params as { itemId: string };

    const item = await prisma.projectItem.findFirst({ where: { id: itemId, projectId: ctx.project.id } });
    if (!item) return reply.status(404).send({ error: "Item not found" });

    const { columnId, position } = request.body as { columnId?: string; position?: number };
    if (typeof position !== "number" || !Number.isFinite(position)) {
      return reply.status(400).send({ error: "position (target index) is required" });
    }
    const targetIndex = Math.max(0, Math.trunc(position));

    const destColumnId = columnId ?? item.columnId;
    if (columnId && columnId !== item.columnId) {
      const destColumn = await prisma.projectColumn.findFirst({ where: { id: columnId, projectId: ctx.project.id } });
      if (!destColumn) return reply.status(404).send({ error: "Column not found" });
    }

    const sourceColumnId = item.columnId;
    const moved = await prisma.$transaction(async (tx) => {
      // Destination order, excluding the moved item, then splice it in at index.
      const dest = await tx.projectItem.findMany({
        where: { columnId: destColumnId, id: { not: item.id } },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      const idx = Math.min(targetIndex, dest.length);
      const orderedIds = [...dest.slice(0, idx).map((d) => d.id), item.id, ...dest.slice(idx).map((d) => d.id)];
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.projectItem.update({
          where: { id: orderedIds[i]! },
          data: orderedIds[i] === item.id ? { position: i, columnId: destColumnId } : { position: i },
        });
      }
      // Renumber the source column when the item left it.
      if (sourceColumnId !== destColumnId) {
        const src = await tx.projectItem.findMany({
          where: { columnId: sourceColumnId },
          orderBy: { position: "asc" },
          select: { id: true },
        });
        for (let i = 0; i < src.length; i++) {
          await tx.projectItem.update({ where: { id: src[i]!.id }, data: { position: i } });
        }
      }
      return tx.projectItem.findFirst({ where: { id: item.id } });
    });

    return {
      id: moved!.id,
      columnId: moved!.columnId,
      position: moved!.position,
      subjectType: toApiType(moved!.subjectType),
      subjectNumber: moved!.subjectNumber,
    };
  });

  // DELETE /repos/:handle/:name/projects/:number/items/:itemId — remove + renumber column.
  app.delete("/repos/:handle/:name/projects/:number/items/:itemId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ctx = await requireWritableProject(request, reply);
    if (!ctx) return reply;
    const { itemId } = request.params as { itemId: string };

    const item = await prisma.projectItem.findFirst({ where: { id: itemId, projectId: ctx.project.id } });
    if (!item) return reply.status(404).send({ error: "Item not found" });

    await prisma.$transaction(async (tx) => {
      await tx.projectItem.delete({ where: { id: item.id } });
      const rest = await tx.projectItem.findMany({
        where: { columnId: item.columnId },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      for (let i = 0; i < rest.length; i++) {
        await tx.projectItem.update({ where: { id: rest[i]!.id }, data: { position: i } });
      }
    });

    return reply.status(204).send();
  });
}
