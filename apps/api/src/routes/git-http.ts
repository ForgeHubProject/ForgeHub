import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bareRepoPathFromKey } from "../git-storage.js";
import { prisma } from "../prisma.js";

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

async function resolveActorIdFromAuthHeader(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<string | undefined> {
  const header = request.headers.authorization;
  if (!header) {
    return undefined;
  }

  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (!token) return undefined;
    try {
      const payload = await app.jwt.verify<{ sub?: string }>(token);
      return payload.sub;
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
      const password = decoded.slice(sep + 1).trim();
      if (!password) return undefined;
      const payload = await app.jwt.verify<{ sub?: string }>(password);
      return payload.sub;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

type AccessRepo = {
  id: string;
  ownerId: string;
  visibility: "PUBLIC" | "PRIVATE";
  storageKey: string | null;
  collaborators: Array<{ userId: string; role: "READER" | "WRITER" }>;
};

function canRead(repo: AccessRepo, actorId: string | undefined): boolean {
  if (repo.visibility === "PUBLIC") return true;
  if (!actorId) return false;
  if (actorId === repo.ownerId) return true;
  return repo.collaborators.some((c) => c.userId === actorId);
}

function canWrite(repo: AccessRepo, actorId: string | undefined): boolean {
  if (!actorId) return false;
  if (actorId === repo.ownerId) return true;
  return repo.collaborators.some((c) => c.userId === actorId && c.role === "WRITER");
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
      where: {
        name: repoName,
        owner: { handle: handleRaw.toLowerCase() },
      },
      include: {
        collaborators: {
          select: { userId: true, role: true },
        },
      },
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actorId = await resolveActorIdFromAuthHeader(app, request);
    const read = canRead(repo, actorId);
    const write = canWrite(repo, actorId);

    if (service === "git-receive-pack" && !write) {
      return reply.status(403).send({ error: "Write access denied" });
    }
    if (service === "git-upload-pack" && !read) {
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
      where: {
        name: repoName,
        owner: { handle: handleRaw.toLowerCase() },
      },
      include: {
        collaborators: {
          select: { userId: true, role: true },
        },
      },
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actorId = await resolveActorIdFromAuthHeader(app, request);
    if (!canRead(repo, actorId)) {
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
      where: {
        name: repoName,
        owner: { handle: handleRaw.toLowerCase() },
      },
      include: {
        collaborators: {
          select: { userId: true, role: true },
        },
      },
    });
    if (!repo || !repo.storageKey) {
      return reply.status(404).send({ error: "Repository not found" });
    }

    const actorId = await resolveActorIdFromAuthHeader(app, request);
    if (!canWrite(repo, actorId)) {
      return reply.status(403).send({ error: "Write access denied" });
    }

    const repoPath = bareRepoPathFromKey(repo.storageKey);
    await pipeGitService(reply, request, "git-receive-pack", repoPath, false);
    return reply;
  });
}
