import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { bareRepoPathFromKey, buildStorageKey, moveBareRepo, removeBareRepo } from "../git-storage.js";
import { newHandleSchema } from "../validation.js";

/**
 * Account settings (#258): change your username, export your data, delete
 * your account. Each is refused to personal access tokens: these belong to a
 * signed-in person on the website, not to a script.
 */

/** Who authored content belongs to once its author deletes their account (GitHub's "ghost"). */
export const GHOST_HANDLE = "ghost";
const GHOST_EMAIL = "ghost@users.forgehub.invalid";

// Every required reference to a user that outlives them: reassigned to the ghost.
// Raw SQL so the reassignment doesn't bump each row's @updatedAt.
const AUTHORED: Array<[table: string, column: string]> = [
  ["PullRequest", "authorId"],
  ["PullRequestReviewerRequest", "requestedById"],
  ["Issue", "authorId"],
  ["IssueComment", "authorId"],
  ["Release", "authorId"],
  ["ReleaseAsset", "uploadedById"],
  ["PullRequestComment", "authorId"],
  ["PullRequestReview", "authorId"],
  ["PullRequestReviewComment", "authorId"],
  ["ProjectItem", "addedById"],
  ["Design", "createdById"],
  ["DesignVersion", "uploadedById"],
];

function sessionOnly(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.patScopes === null) return true;
  void reply.status(403).send({ error: "Manage your account on the website; tokens can't do this" });
  return false;
}

export async function accountRoutes(app: FastifyInstance) {
  // POST /users/me/rename { handle } — your repositories move with you, and
  // their old URLs keep redirecting (web and git) until someone takes the name.
  app.post("/users/me/rename", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const parsed = newHandleSchema.safeParse((request.body as { handle?: unknown } | null)?.handle);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid username" });
    const handle = parsed.data.toLowerCase();
    if (handle === GHOST_HANDLE) return reply.status(400).send({ error: "That name is reserved" });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub }, select: { id: true, handle: true } });
    if (handle === user.handle) return { handle };
    const [userClash, orgClash] = await Promise.all([
      prisma.user.findUnique({ where: { handle }, select: { id: true } }),
      prisma.organization.findUnique({ where: { handle }, select: { id: true } }),
    ]);
    if (userClash || orgClash) return reply.status(409).send({ error: `The username ${handle} is taken` });

    const repos = await prisma.repo.findMany({
      where: { ownerId: user.id, orgId: null },
      select: { id: true, name: true, storageKey: true, updatedAt: true },
    });
    const moved: Array<[from: string, to: string]> = [];
    try {
      for (const r of repos) {
        if (!r.storageKey) continue;
        const to = buildStorageKey(handle, r.name);
        await moveBareRepo(r.storageKey, to);
        moved.push([r.storageKey, to]);
      }
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { handle } }),
        // The new name's old redirects (a previous owner's) end here.
        prisma.repoRedirect.deleteMany({ where: { ownerHandle: handle } }),
        ...repos.flatMap((r) => [
          prisma.repo.update({
            where: { id: r.id },
            // Keep "Updated": moving with its owner isn't a change to the repository.
            data: { storageKey: r.storageKey ? buildStorageKey(handle, r.name) : null, updatedAt: r.updatedAt },
          }),
          prisma.repoRedirect.upsert({
            where: { ownerHandle_name: { ownerHandle: user.handle, name: r.name } },
            create: { ownerHandle: user.handle, name: r.name, repoId: r.id },
            update: { repoId: r.id },
          }),
        ]),
      ]);
    } catch (e) {
      for (const [from, to] of moved.reverse()) await moveBareRepo(to, from).catch(() => undefined);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.status(409).send({ error: `The username ${handle} is taken` });
      }
      throw e;
    }
    if (moved.length > 0) await removeEmptyHandleDir(moved[0][0]);
    return { handle };
  });

  // GET /users/me/export — everything you made here, as JSON (your repositories' git data you clone).
  app.get("/users/me/export", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const id = request.user.sub;
    const repoRef = { select: { name: true, owner: { select: { handle: true } }, org: { select: { handle: true } } } } as const;
    const fullName = (r: { name: string; owner: { handle: string }; org: { handle: string } | null }) =>
      `${r.org?.handle ?? r.owner.handle}/${r.name}`;
    const [user, repos, stars, following, followers, issues, pulls, issueComments, pullComments, keys, tokens] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id } }),
      prisma.repo.findMany({
        where: { ownerId: id },
        select: { name: true, description: true, visibility: true, createdAt: true, owner: { select: { handle: true } }, org: { select: { handle: true } }, topics: { select: { topic: true } } },
      }),
      prisma.star.findMany({ where: { userId: id }, select: { createdAt: true, repo: repoRef } }),
      prisma.follow.findMany({ where: { followerId: id }, select: { createdAt: true, following: { select: { handle: true } } } }),
      prisma.follow.findMany({ where: { followingId: id }, select: { createdAt: true, follower: { select: { handle: true } } } }),
      prisma.issue.findMany({ where: { authorId: id }, select: { number: true, title: true, body: true, state: true, createdAt: true, repo: repoRef } }),
      prisma.pullRequest.findMany({
        where: { authorId: id },
        select: { number: true, title: true, description: true, state: true, fromBranch: true, toBranch: true, createdAt: true, repo: repoRef },
      }),
      prisma.issueComment.findMany({ where: { authorId: id }, select: { body: true, createdAt: true, issue: { select: { number: true, repo: repoRef } } } }),
      prisma.pullRequestComment.findMany({ where: { authorId: id }, select: { body: true, createdAt: true, pullRequest: { select: { number: true, repo: repoRef } } } }),
      prisma.sSHKey.findMany({ where: { userId: id }, select: { title: true, fingerprint: true, createdAt: true } }),
      prisma.personalAccessToken.findMany({ where: { userId: id }, select: { name: true, scopes: true, createdAt: true, expiresAt: true, lastUsedAt: true } }),
    ]);
    const data = {
      exportedAt: new Date().toISOString(),
      account: {
        handle: user.handle, email: user.email, displayName: user.displayName, bio: user.bio, location: user.location,
        website: user.website, pronouns: user.pronouns, company: user.company, createdAt: user.createdAt,
      },
      repositories: repos.map((r) => ({ fullName: fullName(r), description: r.description, visibility: r.visibility, createdAt: r.createdAt, topics: r.topics.map((t) => t.topic) })),
      stars: stars.map((s) => ({ repository: fullName(s.repo), starredAt: s.createdAt })),
      following: following.map((f) => ({ handle: f.following.handle, since: f.createdAt })),
      followers: followers.map((f) => ({ handle: f.follower.handle, since: f.createdAt })),
      issues: issues.map(({ repo, ...i }) => ({ repository: fullName(repo), ...i })),
      pullRequests: pulls.map(({ repo, ...p }) => ({ repository: fullName(repo), ...p })),
      issueComments: issueComments.map((c) => ({ repository: fullName(c.issue.repo), issue: c.issue.number, body: c.body, createdAt: c.createdAt })),
      pullRequestComments: pullComments.map((c) => ({ repository: fullName(c.pullRequest.repo), pullRequest: c.pullRequest.number, body: c.body, createdAt: c.createdAt })),
      sshKeys: keys,
      personalAccessTokens: tokens,
    };
    return reply
      .header("Content-Disposition", `attachment; filename="forgehub-${user.handle}-export.json"`)
      .send(data);
  });

  // DELETE /users/me { password, confirm } — your personal repositories go with
  // you; what you wrote elsewhere stays, credited to the ghost.
  app.delete("/users/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const { password, confirm } = (request.body ?? {}) as { password?: unknown; confirm?: unknown };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub }, select: { id: true, handle: true, passwordHash: true } });
    if (typeof confirm !== "string" || confirm.toLowerCase() !== user.handle) {
      return reply.status(400).send({ error: "Type your username to confirm" });
    }
    if (typeof password !== "string" || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.status(403).send({ error: "Incorrect password" });
    }
    if (user.handle === GHOST_HANDLE) return reply.status(400).send({ error: "The ghost can't be deleted" });

    // An organization must never be left without an owner.
    const owned = await prisma.orgMembership.findMany({ where: { userId: user.id, role: "OWNER" }, select: { orgId: true, org: { select: { handle: true } } } });
    const soleOwnerOf: string[] = [];
    for (const m of owned) {
      const owners = await prisma.orgMembership.count({ where: { orgId: m.orgId, role: "OWNER" } });
      if (owners <= 1) soleOwnerOf.push(m.org.handle);
    }
    if (soleOwnerOf.length > 0) {
      return reply.status(409).send({ error: `You're the only owner of ${soleOwnerOf.join(", ")}. Add another owner or delete the organization first.`, organizations: soleOwnerOf });
    }

    const ghost = await ghostUser();
    if (!ghost) return reply.status(500).send({ error: `The username ${GHOST_HANDLE} belongs to someone; it's needed for deleted accounts` });
    const personal = await prisma.repo.findMany({ where: { ownerId: user.id, orgId: null }, select: { storageKey: true } });
    await prisma.$transaction([
      ...AUTHORED.map(([table, column]) =>
        prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`, ghost.id, user.id),
      ),
      // Organization repositories they created stay with the organization.
      prisma.$executeRawUnsafe(`UPDATE "Repo" SET "ownerId" = ? WHERE "ownerId" = ? AND "orgId" IS NOT NULL`, ghost.id, user.id),
      prisma.user.delete({ where: { id: user.id } }),
    ]);
    for (const r of personal) {
      if (r.storageKey) await removeBareRepo(r.storageKey).catch((err: unknown) => app.log.error({ err }, "removing a deleted account's repository failed"));
    }
    if (personal[0]?.storageKey) await removeEmptyHandleDir(personal[0].storageKey);
    return reply.status(204).send();
  });
}

/** Drop the `<handle>/` folder a storage key lived in, if nothing is left in it. */
async function removeEmptyHandleDir(storageKey: string): Promise<void> {
  await rmdir(path.dirname(bareRepoPathFromKey(storageKey))).catch(() => undefined); // not empty, or already gone
}

/** The ghost account, created on first use; null when a real person holds the name. */
async function ghostUser(): Promise<{ id: string } | null> {
  const existing = await prisma.user.findUnique({ where: { handle: GHOST_HANDLE }, select: { id: true, email: true } });
  if (existing) return existing.email === GHOST_EMAIL ? existing : null;
  // An unusable password hash: nobody can sign in as the ghost.
  return prisma.user.create({
    data: { handle: GHOST_HANDLE, email: GHOST_EMAIL, passwordHash: "!", displayName: "Ghost", bio: "This account was deleted." },
    select: { id: true },
  });
}
