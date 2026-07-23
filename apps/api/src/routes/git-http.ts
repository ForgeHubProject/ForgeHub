import { spawn } from "node:child_process";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bareRepoPathFromKey } from "../git-storage.js";
import { prisma } from "../prisma.js";
import { hashToken } from "../tokens.js";
import { FULL_SCOPES, hasScope, parseScopes, type PatScope } from "../scopes.js";
import { preparePushProtection, runPostReceiveEffects, snapshotHeadShas } from "../git-push-shared.js";
import { canRead, canWrite, repoAccessInclude, repoByOwningHandleWhere } from "../repo-access.js";

/**
 * The authenticated actor plus the scopes their credential carries. Session/JWT
 * and interactive-password auth are unscoped (full power); a Personal Access
 * Token carries exactly the scopes it was minted with, so a push can require
 * `repo:write` (issue #87).
 */
type ActorAuth = { userId: string; scopes: PatScope[] };

type GitService = "git-upload-pack" | "git-receive-pack";

function pktLine(data: string): string {
  const len = Buffer.byteLength(data) + 4;
  return `${len.toString(16).padStart(4, "0")}${data}`;
}

function parseRepoNameWithGitSuffix(rawRepo: string): string | null {
  const repo = rawRepo.toLowerCase();
  if (!repo.endsWith(".git")) {
    return null;
  }
  return repo.slice(0, -4);
}

async function resolveActorFromAuthHeader(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<ActorAuth | undefined> {
  const header = request.headers.authorization;
  if (!header) return undefined;

  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (!token) return undefined;
    try {
      const payload = await app.jwt.verify<{ sub?: string }>(token);
      return payload.sub ? { userId: payload.sub, scopes: [...FULL_SCOPES] } : undefined;
    } catch {
      return undefined;
    }
  }

  if (header.startsWith("Basic ")) {
    const encoded = header.slice("Basic ".length).trim();
    if (!encoded) return undefined;
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep < 0) return undefined;
      const username = decoded.slice(0, sep).trim();
      const password = decoded.slice(sep + 1).trim();
      if (!password) return undefined;

      // Accept JWT token as password (for scripted/CI usage) — unscoped/full.
      try {
        const payload = await app.jwt.verify<{ sub?: string }>(password);
        if (payload.sub) return { userId: payload.sub, scopes: [...FULL_SCOPES] };
      } catch { /* not a JWT, fall through */ }

      // Accept a Personal Access Token as password (scoped, named, revocable — see /auth/tokens)
      const pat = await prisma.personalAccessToken.findUnique({ where: { tokenHash: hashToken(password) } });
      if (pat) {
        if (pat.expiresAt && pat.expiresAt.getTime() < Date.now()) return undefined;
        prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return { userId: pat.userId, scopes: parseScopes(pat.scopes) };
      }

      // Accept handle-or-email + ForgeHub password (for interactive git prompts) — full.
      const user = await prisma.user.findFirst({
        where: { OR: [{ handle: username.toLowerCase() }, { email: username.toLowerCase() }] },
        select: { id: true, passwordHash: true },
      });
      if (user && await bcrypt.compare(password, user.passwordHash)) {
        return { userId: user.id, scopes: [...FULL_SCOPES] };
      }
    } catch { /* ignore */ }
  }

  return undefined;
}

function pipeGitService(
  reply: FastifyReply,
  request: FastifyRequest,
  service: GitService,
  repoPath: string,
  advertiseRefs: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      service.replace("git-", ""),
      "--stateless-rpc",
      ...(advertiseRefs ? ["--advertise-refs"] : []),
      repoPath,
    ];
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    reply.raw.statusCode = 200;
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader(
      "Content-Type",
      advertiseRefs ? `application/x-${service}-advertisement` : `application/x-${service}-result`,
    );

    if (advertiseRefs) {
      reply.raw.write(pktLine(`# service=${service}\n`));
      reply.raw.write("0000");
    }

    child.stdout.pipe(reply.raw, { end: true });

    if (advertiseRefs) {
      request.raw.resume();
    } else {
      const bodyStream = (request.body as NodeJS.ReadableStream | undefined) ?? request.raw;
      bodyStream.pipe(child.stdin);
    }

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `git ${service} exited with ${code}`));
        return;
      }
      resolve();
    });
  });
}

export async function gitHttpRoutes(app: FastifyInstance) {
  app.addContentTypeParser(/^application\/x-git-.*$/, (request, payload, done) => {
    done(null, payload);
  });

  app.get("/git/:handle/:repo/info/refs", async (request, reply) => {
    const query = request.query as { service?: string };
    const service = query.service as GitService | undefined;
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return reply.status(400).send({ error: "Invalid service query parameter" });
    }

    const { handle: handleRaw, repo: repoRaw } = request.params as { handle: string; repo: string };
    const repoName = parseRepoNameWithGitSuffix(repoRaw);
    if (!repoName) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const repo = await prisma.repo.findFirst({
      where: repoByOwningHandleWhere(handleRaw, repoName),
      include: repoAccessInclude,
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actor = await resolveActorFromAuthHeader(app, request);
    const actorId = actor?.userId;
    const read = canRead(repo, actorId);
    // A push needs both repo-role write AND (for PAT credentials) the repo:write scope.
    const write = canWrite(repo, actorId) && (!actor || hasScope(actor.scopes, "repo:write"));

    if (service === "git-receive-pack" && !write) {
      // 401 + WWW-Authenticate so git knows to prompt for credentials.
      // Without this, git just prints "403" and never asks for a password.
      if (!actorId) {
        reply.header("WWW-Authenticate", 'Basic realm="ForgeHub"');
        return reply.status(401).send({ error: "Authentication required" });
      }
      // Authenticated but the token lacks repo:write → scope error, not a role error.
      if (canWrite(repo, actorId) && actor && !hasScope(actor.scopes, "repo:write")) {
        return reply.status(403).send({ error: "Token is missing the 'repo:write' scope" });
      }
      return reply.status(403).send({ error: "Write access denied" });
    }
    if (service === "git-upload-pack" && !read) {
      if (!actorId) {
        reply.header("WWW-Authenticate", 'Basic realm="ForgeHub"');
        return reply.status(401).send({ error: "Authentication required" });
      }
      return reply.status(404).send({ error: "Repository not found" });
    }

    const repoPath = bareRepoPathFromKey(repo.storageKey);
    await pipeGitService(reply, request, service, repoPath, true);
    return reply;
  });

  app.post("/git/:handle/:repo/git-upload-pack", async (request, reply) => {
    const { handle: handleRaw, repo: repoRaw } = request.params as { handle: string; repo: string };
    const repoName = parseRepoNameWithGitSuffix(repoRaw);
    if (!repoName) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const repo = await prisma.repo.findFirst({
      where: repoByOwningHandleWhere(handleRaw, repoName),
      include: repoAccessInclude,
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actor = await resolveActorFromAuthHeader(app, request);
    if (!canRead(repo, actor?.userId)) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const repoPath = bareRepoPathFromKey(repo.storageKey);
    await pipeGitService(reply, request, "git-upload-pack", repoPath, false);
    return reply;
  });

  app.post("/git/:handle/:repo/git-receive-pack", async (request, reply) => {
    const { handle: handleRaw, repo: repoRaw } = request.params as { handle: string; repo: string };
    const repoName = parseRepoNameWithGitSuffix(repoRaw);
    if (!repoName) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const repo = await prisma.repo.findFirst({
      where: repoByOwningHandleWhere(handleRaw, repoName),
      include: repoAccessInclude,
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actor = await resolveActorFromAuthHeader(app, request);
    if (!actor) {
      reply.header("WWW-Authenticate", 'Basic realm="ForgeHub"');
      return reply.status(401).send({ error: "Authentication required" });
    }
    const actorId = actor.userId;
    if (!canWrite(repo, actorId)) {
      return reply.status(403).send({ error: "Write access denied" });
    }
    // PAT credentials must carry the repo:write scope to push (issue #87).
    if (!hasScope(actor.scopes, "repo:write")) {
      return reply.status(403).send({ error: "Token is missing the 'repo:write' scope" });
    }

    const repoPath = bareRepoPathFromKey(repo.storageKey);

    // Branch protection (issue #85): make sure the pre-receive hook is installed
    // (backfills repos predating the feature) and refresh its rules file from the
    // DB so it enforces the current policy. The hook rejects protected-branch
    // violations BEFORE the pack is accepted (pre-receive); server-side merges push
    // through local git with FORGEHUB_INTERNAL_PUSH=1 and bypass it. Shared with the
    // SSH transport (issue #116) so both write paths enforce identically.
    await preparePushProtection(app, repo.id, repo.storageKey, repoPath);

    // Snapshot all branch SHAs before the push, run receive-pack, then fire the
    // shared post-receive side effects (ingestion + webhooks + CI). Both effects
    // are identical to the SSH transport's, so a push is indistinguishable
    // downstream regardless of transport.
    const shasBefore = await snapshotHeadShas(repoPath);

    await pipeGitService(reply, request, "git-receive-pack", repoPath, false);

    await runPostReceiveEffects(app, { id: repo.id, storageKey: repo.storageKey }, actorId, repoPath, shasBefore);

    return reply;
  });
}
