import type { FastifyInstance } from "fastify";
import { buildStorageKey, createBareRepo, removeBareRepo } from "../git-storage.js";
import { fetchGithubOrg, ImportError, MAX_IMPORT_KB, parseGithubOrg } from "../github-import.js";
import { runImportQueue } from "../github-import-queue.js";
import { isHandleTaken } from "../owner-resolve.js";
import { prisma } from "../prisma.js";
import { importGithubOrgBodySchema, isGithubAvatarUrl } from "../validation.js";
import { ensureImplicitWatch } from "../watch-service.js";
import { setOrgAvatar } from "./orgs.js";
import { avatarMaxBytes, detectImageType } from "./profile.js";

// Import a GitHub organization (#308): the organization, then the public
// repositories the person picks, each through #289's import, one after another.

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * A new organization's picture, copied from its GitHub organization (#308). Only
 * GitHub's avatar host, no redirects, at most the avatar size cap, and only a
 * PNG, JPEG or WebP; anything else leaves the letter avatar. Never throws.
 */
export async function copyGithubAvatar(app: FastifyInstance, orgId: string, url: string): Promise<boolean> {
  if (!isGithubAvatarUrl(url)) return false;
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !res.body) return false;
    const max = avatarMaxBytes();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) return false;
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    if (!detectImageType(buf)) return false;
    await setOrgAvatar(orgId, buf);
    return true;
  } catch (err) {
    app.log.warn({ err }, "copying a GitHub organization's avatar failed");
    return false;
  }
}

export async function githubOrgImportRoutes(app: FastifyInstance) {
  // GET /import/github/orgs/:login — the organization and its public repositories, to pick from.
  // Signed in only: each look costs the server's GitHub requests.
  app.get("/import/github/orgs/:login", { preHandler: [app.authenticate] }, async (request, reply) => {
    const login = parseGithubOrg((request.params as { login: string }).login);
    if (!login) return reply.status(400).send({ error: "Enter a GitHub organization as https://github.com/name or name" });
    try {
      const org = await fetchGithubOrg(login);
      return { ...org, maxSizeKb: MAX_IMPORT_KB };
    } catch (e) {
      if (e instanceof ImportError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  });

  // POST /import/github/orgs/:login { into, repos, importIssues } — create the organization (or
  // use one the caller owns) and queue each repository. Every name is checked before anything is made.
  app.post("/import/github/orgs/:login", { preHandler: [app.authenticate] }, async (request, reply) => {
    const login = parseGithubOrg((request.params as { login: string }).login);
    if (!login) return reply.status(400).send({ error: "Enter a GitHub organization as https://github.com/name or name" });
    const parsed = importGithubOrgBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    const { into, repos, importIssues } = parsed.data;
    const userId = request.user.sub;

    const twice = (list: string[]) => [...new Set(list.filter((n, i) => list.indexOf(n) !== i))];
    const sources = twice(repos.map((r) => r.name.toLowerCase()));
    if (sources.length) return reply.status(400).send({ error: `${sources.join(", ")} is picked more than once` });
    const names = repos.map((r) => r.as.toLowerCase());
    const clashing = twice(names);
    if (clashing.length) {
      return reply.status(400).send({ error: "Give each repository its own name", taken: clashing });
    }

    const handle = into.handle.toLowerCase();
    let orgId: string | undefined;
    if (into.create) {
      if (await isHandleTaken(handle)) return reply.status(409).send({ error: `The name ${handle} is taken`, field: "handle" });
    } else {
      const org = await prisma.organization.findUnique({ where: { handle }, select: { id: true } });
      const membership = org && (await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId } } }));
      if (!org || !membership) return reply.status(404).send({ error: "Organization not found" });
      if (membership.role !== "OWNER") return reply.status(403).send({ error: "Only an owner of the organization can import into it" });
      const existing = await prisma.repo.findMany({
        where: { storageKey: { in: names.map((n) => buildStorageKey(handle, n)) } },
        select: { name: true },
      });
      if (existing.length) {
        const taken = existing.map((r) => r.name);
        return reply.status(409).send({ error: `${handle} already has ${taken.length === 1 ? "a repository" : "repositories"} named ${taken.join(", ")}`, taken });
      }
      orgId = org.id;
    }

    if (into.create) {
      try {
        const org = await prisma.organization.create({
          data: {
            handle,
            displayName: into.displayName || into.handle,
            description: into.description?.trim() || null,
            website: into.website || null,
            location: into.location || null,
            memberships: { create: { userId, role: "OWNER" } },
          },
          select: { id: true },
        });
        orgId = org.id;
      } catch (e) {
        if (errorCode(e) === "P2002") return reply.status(409).send({ error: `The name ${handle} is taken`, field: "handle" });
        throw e;
      }
    }

    // In the order given, which is the order they import in.
    const queued: string[] = [];
    const skipped: string[] = [];
    for (const r of repos) {
      const name = r.as.toLowerCase();
      const storageKey = buildStorageKey(handle, name);
      try {
        await createBareRepo(storageKey);
      } catch (e) {
        // Made meanwhile, or storage left without a repository: never touched.
        if (errorCode(e) === "EEXIST") {
          skipped.push(name);
          continue;
        }
        throw e;
      }
      let repo;
      try {
        repo = await prisma.repo.create({
          data: {
            name,
            visibility: "PUBLIC",
            storageKey,
            ownerId: userId,
            orgId: orgId!,
            importSource: `${login}/${r.name}`,
            importStatus: "queued",
            ...(importIssues && { issueImport: { create: {} } }),
          },
          select: { id: true },
        });
      } catch (e) {
        await removeBareRepo(storageKey);
        if (errorCode(e) === "P2002") {
          skipped.push(name);
          continue;
        }
        throw e;
      }
      await ensureImplicitWatch(repo.id, userId);
      queued.push(name);
    }
    void runImportQueue(app, userId);
    if (into.create && into.avatarUrl) void copyGithubAvatar(app, orgId!, into.avatarUrl);
    return reply.status(201).send({ org: handle, queued, skipped });
  });

  // GET /orgs/:handle/imports — how the organization's imported repositories are getting on.
  // Members only, like its settings; outsiders get the same 404 as a missing organization.
  app.get("/orgs/:handle/imports", { preHandler: [app.authenticate] }, async (request, reply) => {
    const handle = (request.params as { handle: string }).handle.toLowerCase();
    const org = await prisma.organization.findUnique({ where: { handle }, select: { id: true } });
    const membership = org && (await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: request.user.sub } } }));
    if (!org || !membership) return reply.status(404).send({ error: "Organization not found" });
    const repos = await prisma.repo.findMany({
      where: { orgId: org.id, importSource: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        name: true,
        importSource: true,
        importStatus: true,
        importError: true,
        issueImport: { select: { stage: true, issues: true, pulls: true, comments: true, releases: true, waitUntil: true, error: true } },
      },
    });
    const now = new Date();
    return {
      viewerRole: membership.role === "OWNER" ? "OWNER" : "MEMBER",
      repos: repos.map((r) => ({
        name: r.name,
        source: r.importSource,
        status: r.importStatus ?? "done",
        error: r.importError,
        issues: r.issueImport && {
          ...r.issueImport,
          waitUntil: r.issueImport.waitUntil && r.issueImport.waitUntil > now ? r.issueImport.waitUntil.toISOString() : null,
        },
      })),
    };
  });
}
