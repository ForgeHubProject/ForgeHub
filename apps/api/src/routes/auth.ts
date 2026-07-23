import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";
import { loginBodySchema, registerBodySchema } from "../validation.js";

/**
 * Record an interactive-login Session (issue #117) and mint a JWT that carries
 * its id as the `sid` claim, so the login can later be listed and revoked. The
 * device/UA and IP are captured best-effort for the sessions settings page.
 */
async function issueSessionToken(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<string> {
  const userAgent = (request.headers["user-agent"] ?? "").slice(0, 512) || null;
  const ip = request.ip || null;
  const session = await prisma.session.create({ data: { userId, userAgent, ip } });
  return reply.jwtSign({ sub: userId, sid: session.id });
}

type DbUser = {
  id: string; email: string; handle: string; displayName: string | null;
  bio: string | null; location: string | null; website: string | null; createdAt: Date;
  emailNotifications: boolean;
};

function publicUser(u: DbUser) {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    displayName: u.displayName,
    bio: u.bio,
    location: u.location,
    website: u.website,
    emailNotifications: u.emailNotifications,
    createdAt: u.createdAt.toISOString(),
  };
}

function publicProfile(u: DbUser) {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName,
    bio: u.bio,
    location: u.location,
    website: u.website,
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
        data: { email, handle, passwordHash, displayName: parsed.data.displayName?.trim() || null },
      });
      const token = await issueSessionToken(request, reply, user.id);
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
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = await issueSessionToken(request, reply, user.id);
    return { user: publicUser(user), token };
  });

  app.get("/auth/me", { preHandler: [app.authenticate] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub } });
    return { user: publicUser(user) };
  });

  // Public profile — no auth required
  app.get("/users/:handle", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const user = await prisma.user.findUnique({ where: { handle: handle.toLowerCase() } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    return publicProfile(user);
  });

  // Update own profile
  app.patch("/users/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { displayName, bio, location, website, emailNotifications } = request.body as {
      displayName?: string; bio?: string; location?: string; website?: string; emailNotifications?: boolean;
    };

    const data: Record<string, string | boolean | null> = {};
    if (displayName !== undefined) data.displayName = displayName.trim() || null;
    if (bio !== undefined) data.bio = bio.trim() || null;
    if (location !== undefined) data.location = location.trim() || null;
    if (website !== undefined) data.website = website.trim() || null;
    if (emailNotifications !== undefined) data.emailNotifications = Boolean(emailNotifications);

    if (Object.keys(data).length === 0) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub } });
      return { user: publicUser(user) };
    }

    const user = await prisma.user.update({ where: { id: request.user.sub }, data });
    return { user: publicUser(user) };
  });
}
