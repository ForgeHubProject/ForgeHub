import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";
import { loginBodySchema, registerBodySchema } from "../validation.js";
import { registrationMode } from "../registration.js";
import { createUserAccount } from "../user-service.js";

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
  emailNotifications: boolean; avatarKey: string | null;
  // Profile (#257); optional so narrower rows and mocks still format.
  pronouns?: string | null; company?: string | null; socialLinks?: string | null;
  statusEmoji?: string | null; statusText?: string | null; statusExpiresAt?: Date | null;
  privateProfile?: boolean;
  showEmail?: boolean; timezone?: string | null;
};

/** The profile fields #257 added, as the API shows them; an expired status reads as none. */
function profileExtras(u: DbUser) {
  const live = !u.statusExpiresAt || u.statusExpiresAt > new Date();
  return {
    pronouns: u.pronouns ?? null,
    company: u.company ?? null,
    socialLinks: parseLinks(u.socialLinks),
    status: live && (u.statusEmoji || u.statusText)
      ? { emoji: u.statusEmoji ?? null, text: u.statusText ?? null, expiresAt: u.statusExpiresAt?.toISOString() ?? null }
      : null,
  };
}

function parseLinks(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A social link: an http(s) URL, at most 200 characters. */
function isLink(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 200) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** An IANA time zone the runtime knows ("Europe/Istanbul"). */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

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
    avatarKey: u.avatarKey,
    ...profileExtras(u),
    privateProfile: u.privateProfile ?? false,
    showEmail: u.showEmail ?? false,
    timezone: u.timezone ?? null,
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
    avatarKey: u.avatarKey,
    ...profileExtras(u),
    // Profile (#257): the email only when they chose to show it; their time zone for "local time".
    email: u.showEmail ? u.email : null,
    timezone: u.timezone ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    if (registrationMode() === "closed") {
      return reply.status(403).send({ error: "Registration is closed on this server" });
    }
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const user = await createUserAccount(parsed.data);
    if (!user) {
      return reply.status(409).send({ error: "Email or handle already taken" });
    }
    const token = await issueSessionToken(request, reply, user.id);
    return reply.status(201).send({ user: publicUser(user), token });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    // Email or handle, told apart by "@" (handleSchema forbids it, so the two
    // grammars cannot overlap). Both are stored lowercased — registration
    // lowercases them and /users/:handle looks up lowercased — so one
    // normalization serves both lookups. Trimming already happened in the
    // schema, before validation (see loginBodySchema).
    const identifier = parsed.data.email.toLowerCase();
    const user = identifier.includes("@")
      ? await prisma.user.findUnique({ where: { email: identifier } })
      : await prisma.user.findUnique({ where: { handle: identifier } });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return reply.status(401).send({ error: "Incorrect username, email, or password" });
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
    // Following (#257): the counts, and whether the viewer follows them.
    const viewer = (request as { user?: { sub: string } }).user?.sub;
    const [viewerFollows, viewerBlocks] = viewer && viewer !== user.id
      ? await Promise.all([
          prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer, followingId: user.id } } }).then(Boolean),
          // Settings (#258): whether the viewer blocked them, for the profile's Block / Unblock.
          prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: viewer, blockedId: user.id } } }).then(Boolean),
        ])
      : [false, false];
    // A private profile (#257) hides its status and follow counts from everyone
    // else; whether the viewer follows them is the viewer's own to know.
    if (user.privateProfile && viewer !== user.id) {
      return { ...publicProfile(user), status: null, privateProfile: true, followers: null, following: null, organizations: [], viewerFollows, viewerBlocks };
    }
    const [followers, following, memberships] = await Promise.all([
      prisma.follow.count({ where: { followingId: user.id } }),
      prisma.follow.count({ where: { followerId: user.id } }),
      // Organizations they chose to show (#257).
      prisma.orgMembership.findMany({
        where: { userId: user.id, public: true },
        select: { org: { select: { handle: true, displayName: true } } },
        orderBy: { org: { handle: "asc" } },
      }),
    ]);
    return {
      ...publicProfile(user),
      privateProfile: user.privateProfile ?? false,
      followers,
      following,
      organizations: memberships.map((m) => m.org),
      viewerFollows,
      viewerBlocks,
    };
  });

  // Update own profile
  app.patch("/users/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { displayName, bio, location, website, emailNotifications, pronouns, company, socialLinks, status, privateProfile, showEmail, timezone } = request.body as {
      displayName?: string; bio?: string; location?: string; website?: string; emailNotifications?: boolean;
      pronouns?: string; company?: string; socialLinks?: unknown; privateProfile?: boolean;
      showEmail?: boolean; timezone?: string | null;
      status?: { emoji?: string | null; text?: string | null; expiresAt?: string | null } | null;
    };

    const data: Record<string, string | boolean | Date | null> = {};
    // Profile (#257).
    if (pronouns !== undefined) data.pronouns = String(pronouns).trim().slice(0, 30) || null;
    if (company !== undefined) data.company = String(company).trim().slice(0, 100) || null;
    if (socialLinks !== undefined) {
      const links = Array.isArray(socialLinks) ? socialLinks.map((l) => (typeof l === "string" ? l.trim() : l)).filter((l) => l !== "") : null;
      if (!links || links.length > 4 || !links.every(isLink)) {
        return reply.status(400).send({ error: "socialLinks must be up to four http(s) URLs" });
      }
      data.socialLinks = links.length ? JSON.stringify(links) : null;
    }
    if (status !== undefined) {
      const expires = status?.expiresAt ? new Date(status.expiresAt) : null;
      if (expires && Number.isNaN(expires.getTime())) return reply.status(400).send({ error: "Invalid status expiry" });
      data.statusEmoji = status?.emoji?.trim().slice(0, 16) || null;
      data.statusText = status?.text?.trim().slice(0, 80) || null;
      data.statusExpiresAt = data.statusEmoji || data.statusText ? expires : null;
    }
    if (displayName !== undefined) data.displayName = displayName.trim() || null;
    if (bio !== undefined) data.bio = bio.trim() || null;
    if (location !== undefined) data.location = location.trim() || null;
    if (website !== undefined) data.website = website.trim() || null;
    if (emailNotifications !== undefined) data.emailNotifications = Boolean(emailNotifications);
    if (privateProfile !== undefined) data.privateProfile = Boolean(privateProfile);
    if (showEmail !== undefined) data.showEmail = Boolean(showEmail);
    if (timezone !== undefined) {
      if (timezone && !isTimeZone(timezone)) return reply.status(400).send({ error: "Unknown time zone" });
      data.timezone = timezone || null;
    }

    if (Object.keys(data).length === 0) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub } });
      return { user: publicUser(user) };
    }

    const user = await prisma.user.update({ where: { id: request.user.sub }, data });
    return { user: publicUser(user) };
  });
}
