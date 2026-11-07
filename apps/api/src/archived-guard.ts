import type { FastifyInstance } from "fastify";
import { prisma } from "./prisma.js";
import { repoByOwningHandleWhere } from "./repo-access.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What an archived repository still takes: unarchiving it (its settings),
 * deleting it, and starring or watching it, as on GitHub.
 */
const ALLOWED = [/^\/repos\/:handle\/:name$/, /^\/repos\/:handle\/:name\/settings$/, /^\/repos\/:handle\/:name\/(star|watch)$/];

/**
 * Archived repositories are read-only (#256). canWrite already refuses pushes
 * and writers' changes, but issues, comments, reviews and reactions only need
 * read access; this refuses every write under /repos/:handle/:name at once.
 */
export function registerArchivedGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!WRITES.has(request.method)) return;
    const route = request.routeOptions.url ?? "";
    if (!route.startsWith("/repos/:handle/:name") || ALLOWED.some((re) => re.test(route))) return;
    const { handle, name } = request.params as { handle?: string; name?: string };
    if (!handle || !name) return;
    let archived = 0;
    try {
      archived = await prisma.repo.count({ where: { ...repoByOwningHandleWhere(handle, name), archivedAt: { not: null } } });
    } catch {
      // A lookup failure leaves the decision to the route, which reads the repo itself.
      return;
    }
    if (archived > 0) {
      return reply.status(403).send({ error: "This repository is archived and read-only." });
    }
  });
}
