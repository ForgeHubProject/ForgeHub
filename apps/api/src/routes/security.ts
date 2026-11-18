import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";
import { registerBodySchema } from "../validation.js";
import { hashPassword } from "../user-service.js";
import {
  base32, decryptSecret, encryptSecret, hashRecoveryCode, matchTotp, newRecoveryCodes, newTotpSecret, otpauthUri,
} from "../two-factor.js";
import { sessionOnly } from "./account.js";

/**
 * Settings → Password and authentication (#258): change your password, and turn
 * two-factor authentication on and off. Every change asks for your password, so a
 * stolen session alone can't lock you out; tokens can't do any of it.
 */

type Me = { id: string; handle: string; passwordHash: string; totpSecret: string | null; totpEnabledAt: Date | null };

/** The signed-in user when `password` is theirs; otherwise answers 403 and returns null. */
async function withPassword(request: FastifyRequest, reply: FastifyReply, password: unknown): Promise<Me | null> {
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: request.user.sub },
    select: { id: true, handle: true, passwordHash: true, totpSecret: true, totpEnabledAt: true },
  });
  if (typeof password !== "string" || !(await bcrypt.compare(password, me.passwordHash))) {
    void reply.status(403).send({ error: "Incorrect password" });
    return null;
  }
  return me;
}

/** Replace `userId`'s recovery codes with ten new ones; the plain codes, shown once. */
function recoveryCodeWrites(userId: string, codes: string[]) {
  return [
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) }),
  ];
}

export async function securityRoutes(app: FastifyInstance) {
  // POST /users/me/password { currentPassword, newPassword } — signs out every other session.
  app.post("/users/me/password", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const { currentPassword, newPassword } = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const parsed = registerBodySchema.shape.password.safeParse(newPassword);
    if (!parsed.success) return reply.status(400).send({ error: "Your new password needs 8 to 128 characters" });
    const me = await withPassword(request, reply, currentPassword);
    if (!me) return reply;
    const sid = request.user.sid;
    await prisma.$transaction([
      prisma.user.update({ where: { id: me.id }, data: { passwordHash: await hashPassword(parsed.data) } }),
      prisma.session.updateMany({
        where: { userId: me.id, revokedAt: null, ...(sid ? { id: { not: sid } } : {}) },
        data: { revokedAt: new Date() },
      }),
      // A second sign-in step opened with the old password closes too.
      prisma.loginChallenge.deleteMany({ where: { userId: me.id } }),
    ]);
    return reply.status(204).send();
  });

  // GET /users/me/two-factor — whether it's on, and how many recovery codes are left.
  app.get("/users/me/two-factor", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const [me, recoveryCodesLeft] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: request.user.sub }, select: { totpEnabledAt: true } }),
      prisma.recoveryCode.count({ where: { userId: request.user.sub } }),
    ]);
    return { enabled: me.totpEnabledAt !== null, recoveryCodesLeft };
  });

  // POST /users/me/two-factor/setup — a new secret for the authenticator app; it's
  // not used for signing in until /enable confirms a code from it.
  app.post("/users/me/two-factor/setup", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const me = await prisma.user.findUniqueOrThrow({ where: { id: request.user.sub }, select: { id: true, handle: true, totpEnabledAt: true } });
    if (me.totpEnabledAt) return reply.status(409).send({ error: "Two-factor authentication is already on" });
    const secret = newTotpSecret();
    await prisma.user.update({ where: { id: me.id }, data: { totpSecret: encryptSecret(secret), totpLastStep: null } });
    return { secret: base32(secret), uri: otpauthUri(secret, me.handle) };
  });

  // POST /users/me/two-factor/enable { password, code } — turns it on; answers the recovery codes, once.
  app.post("/users/me/two-factor/enable", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const { password, code } = (request.body ?? {}) as { password?: unknown; code?: unknown };
    const me = await withPassword(request, reply, password);
    if (!me) return reply;
    if (me.totpEnabledAt) return reply.status(409).send({ error: "Two-factor authentication is already on" });
    const secret = me.totpSecret ? decryptSecret(me.totpSecret) : null;
    if (!secret) return reply.status(400).send({ error: "Start the setup again" });
    const step = typeof code === "string" ? matchTotp(secret, code.replace(/\s+/g, ""), null) : null;
    if (step === null) return reply.status(400).send({ error: "That code didn't match. Check the time on your device and try a new code." });
    // Only the secret the code was checked against, so a racing setup can't swap in one the app lacks (#258).
    const won = await prisma.user.updateMany({
      where: { id: me.id, totpEnabledAt: null, totpSecret: me.totpSecret },
      data: { totpEnabledAt: new Date(), totpLastStep: step },
    });
    if (won.count === 0) return reply.status(409).send({ error: "Start the setup again" });
    const recoveryCodes = newRecoveryCodes();
    await prisma.$transaction(recoveryCodeWrites(me.id, recoveryCodes));
    return { recoveryCodes };
  });

  // POST /users/me/two-factor/recovery-codes { password } — new codes; the old ones stop working.
  app.post("/users/me/two-factor/recovery-codes", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const me = await withPassword(request, reply, (request.body as { password?: unknown } | null)?.password);
    if (!me) return reply;
    if (!me.totpEnabledAt) return reply.status(409).send({ error: "Two-factor authentication is off" });
    const recoveryCodes = newRecoveryCodes();
    await prisma.$transaction(recoveryCodeWrites(me.id, recoveryCodes));
    return { recoveryCodes };
  });

  // DELETE /users/me/two-factor { password } — turns it off: the secret and the recovery codes go.
  app.delete("/users/me/two-factor", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!sessionOnly(request, reply)) return reply;
    const me = await withPassword(request, reply, (request.body as { password?: unknown } | null)?.password);
    if (!me) return reply;
    await prisma.$transaction([
      prisma.user.update({ where: { id: me.id }, data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null } }),
      prisma.recoveryCode.deleteMany({ where: { userId: me.id } }),
      prisma.loginChallenge.deleteMany({ where: { userId: me.id } }),
    ]);
    return reply.status(204).send();
  });
}
