import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { generateToken } from "../tokens.js";
import { createTokenBodySchema } from "../validation.js";

export async function tokenRoutes(app: FastifyInstance) {
  app.post("/auth/tokens", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createTokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const { token, hash, prefix } = generateToken();
    const record = await prisma.personalAccessToken.create({
      data: { userId: request.user.sub, name: parsed.data.name, tokenHash: hash, tokenPrefix: prefix, expiresAt },
    });

    // `token` is only ever returned here, at creation time — the server never stores or shows it again.
    return reply.status(201).send({
      id: record.id,
      name: record.name,
      token,
      prefix: record.tokenPrefix,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    });
  });

  app.get("/auth/tokens", { preHandler: [app.authenticate] }, async (request) => {
    const tokens = await prisma.personalAccessToken.findMany({
      where: { userId: request.user.sub },
      orderBy: { createdAt: "desc" },
    });
    return {
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.tokenPrefix,
        expiresAt: t.expiresAt?.toISOString() ?? null,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  app.delete("/auth/tokens/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const token = await prisma.personalAccessToken.findUnique({ where: { id } });
    if (!token || token.userId !== request.user.sub) {
      return reply.status(404).send({ error: "Token not found" });
    }
    await prisma.personalAccessToken.delete({ where: { id } });
    return reply.status(204).send();
  });
}
