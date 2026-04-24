import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";
import { loginBodySchema, registerBodySchema } from "../validation.js";

function publicUser(u: { id: string; email: string; handle: string; displayName: string | null; createdAt: Date }) {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    displayName: u.displayName,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const handle = parsed.data.handle.toLowerCase();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    try {
      const user = await prisma.user.create({
        data: {
          email,
          handle,
          passwordHash,
          displayName: parsed.data.displayName?.trim() || null,
        },
      });
      const token = await reply.jwtSign({ sub: user.id });
      return reply.status(201).send({ user: publicUser(user), token });
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return reply.status(409).send({ error: "Email or handle already taken" });
      }
      throw e;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = await reply.jwtSign({ sub: user.id });
    return { user: publicUser(user), token };
  });

  app.get(
    "/auth/me",
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub } });
      return { user: publicUser(user) };
    },
  );
}
