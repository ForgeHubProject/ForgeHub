import type { FastifyInstance } from "fastify";
import { prisma } from "./prisma.js";
import { repoByOwningHandleWhere } from "./repo-access.js";

const FEATURES: Array<{ route: RegExp; flag: "hasIssues" | "hasProjects"; name: string }> = [
  { route: /^\/repos\/:handle\/:name\/issues(\/|$)/, flag: "hasIssues", name: "Issues" },
  { route: /^\/repos\/:handle\/:name\/projects(\/|$)/, flag: "hasProjects", name: "Projects" },
];

/**
 * Features switched off in a repository's settings (#256): its issue or
 * project routes answer 404, reads and writes alike, as on GitHub.
 */
export function registerFeatureGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    const feature = FEATURES.find((f) => f.route.test(route));
    if (!feature) return;
    const { handle, name } = request.params as { handle?: string; name?: string };
    if (!handle || !name) return;
    let off = 0;
    try {
      off = await prisma.repo.count({ where: { ...repoByOwningHandleWhere(handle, name), [feature.flag]: false } });
    } catch {
      return; // the route reads the repo itself
    }
    if (off > 0) return reply.status(404).send({ error: `${feature.name} are turned off for this repository` });
  });
}
