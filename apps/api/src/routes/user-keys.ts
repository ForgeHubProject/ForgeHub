import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { createSSHKeyBodySchema } from "../validation.js";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";
import { fingerprintInUse } from "../ssh/store.js";

/**
 * A user's SSH public keys (issue #116), mounted under `/user/keys`. Mirrors the
 * PAT CRUD in `routes/tokens.ts`: managing keys is an `admin`-scoped action (a
 * session/JWT always passes; a PAT must carry `admin`). The stored public key is
 * public by nature, so listing returns it alongside the fingerprint — but never a
 * private key, which the server never sees.
 */

type SSHKeyRow = {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function publicSSHKey(k: SSHKeyRow) {
  return {
    id: k.id,
    title: k.title,
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

export async function userKeyRoutes(app: FastifyInstance) {
  const admin = app.requireScope("admin");

  // GET /user/keys — list the caller's SSH keys
  app.get("/user/keys", { preHandler: [app.authenticate, admin] }, async (request) => {
    const keys = await prisma.sSHKey.findMany({
      where: { userId: request.user.sub },
      orderBy: { createdAt: "desc" },
    });
    return { keys: keys.map(publicSSHKey) };
  });

  // POST /user/keys — add a key (parses + fingerprints; deduped across both tables)
  app.post("/user/keys", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const parsed = createSSHKeyBodySchema.safeParse(request.body);
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

    const record = await prisma.sSHKey.create({
      data: { userId: request.user.sub, title: parsed.data.title, publicKey: key.normalized, fingerprint },
    });
    return reply.status(201).send(publicSSHKey(record));
  });

  // DELETE /user/keys/:id — remove one of the caller's keys
  app.delete("/user/keys/:id", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const key = await prisma.sSHKey.findUnique({ where: { id } });
    if (!key || key.userId !== request.user.sub) {
      return reply.status(404).send({ error: "Key not found" });
    }
    await prisma.sSHKey.delete({ where: { id } });
    return reply.status(204).send();
  });
}
