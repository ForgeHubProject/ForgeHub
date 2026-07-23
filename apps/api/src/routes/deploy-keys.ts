import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { resolveRepo } from "../repo-access.js";
import { createDeployKeyBodySchema } from "../validation.js";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";
import { fingerprintInUse } from "../ssh/store.js";

/**
 * Repo deploy keys (issue #116), mounted under `/repos/:handle/:name/keys`. A
 * deploy key is a repo-scoped SSH credential for CI/automation; it is read-only by
 * default and grants write only when a repo admin flips `readOnly` off. Management
 * is owner-only + `admin`-scoped, mirroring the webhook routes exactly. The public
 * key is public, so it is returned; the fingerprint identifies it.
 */

type DeployKeyRow = {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  readOnly: boolean;
  createdAt: Date;
};

function publicDeployKey(k: DeployKeyRow) {
  return {
    id: k.id,
    title: k.title,
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
    readOnly: k.readOnly,
    createdAt: k.createdAt.toISOString(),
  };
}

export async function deployKeyRoutes(app: FastifyInstance) {
  const admin = app.requireScope("admin");

  // Resolve the repo and assert the caller is its owner (same gate as webhooks).
  async function ownerRepo(request: FastifyRequest, reply: FastifyReply) {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo) {
      reply.status(404).send({ error: "Not found" });
      return null;
    }
    if (repo.ownerId !== userId) {
      reply.status(repo.visibility === "PRIVATE" ? 404 : 403).send({ error: "Only the repository owner can manage deploy keys" });
      return null;
    }
    return repo;
  }

  // GET /repos/:handle/:name/keys — list deploy keys (owner only)
  app.get("/repos/:handle/:name/keys", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const keys = await prisma.deployKey.findMany({ where: { repoId: repo.id }, orderBy: { createdAt: "desc" } });
    return { keys: keys.map(publicDeployKey) };
  });

  // POST /repos/:handle/:name/keys — add a deploy key (deduped across both tables)
  app.post("/repos/:handle/:name/keys", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;

    const parsed = createDeployKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const key = parsePublicKey(parsed.data.publicKey);
    if (!key) {
      return reply.status(400).send({ error: "Could not parse SSH public key" });
    }

    const fingerprint = fingerprintFromRaw(key.raw);
    if (await fingerprintInUse(fingerprint)) {
      return reply.status(409).send({ error: "This key is already in use" });
    }

    const record = await prisma.deployKey.create({
      data: {
        repoId: repo.id,
        title: parsed.data.title,
        publicKey: key.normalized,
        fingerprint,
        readOnly: parsed.data.readOnly ?? true,
      },
    });
    return reply.status(201).send(publicDeployKey(record));
  });

  // DELETE /repos/:handle/:name/keys/:id
  app.delete("/repos/:handle/:name/keys/:id", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const { id } = request.params as { id: string };

    const key = await prisma.deployKey.findFirst({ where: { id, repoId: repo.id } });
    if (!key) return reply.status(404).send({ error: "Deploy key not found" });

    await prisma.deployKey.delete({ where: { id } });
    return reply.status(204).send();
  });
}
