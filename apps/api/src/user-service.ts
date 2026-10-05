import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import type { z } from "zod";
import type { registerBodySchema } from "./validation.js";

export type NewUserInput = z.infer<typeof registerBodySchema>;

/** Creates a user the way POST /auth/register does. Returns null when the email/handle is already taken (including by an org handle). */
export async function createUserAccount(input: NewUserInput) {
  const email = input.email.trim().toLowerCase();
  const handle = input.handle.toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, 12);

  // Users and orgs share one handle space (issue #114): reject a handle already
  // claimed by an org. The reverse (org-create vs existing user) is enforced in
  // the orgs route; user↔user collisions are caught by the unique index below.
  const orgClash = await prisma.organization.findUnique({ where: { handle } });
  if (orgClash) return null;

  try {
    return await prisma.user.create({
      data: { email, handle, passwordHash, displayName: input.displayName?.trim() || null },
    });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return null;
    }
    throw e;
  }
}
