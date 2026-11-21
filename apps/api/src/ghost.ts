import { prisma } from "./prisma.js";

/**
 * GitHub's "ghost": who authored content belongs to once its author deletes their
 * account, and who content brought over from GitHub belongs to when its author has
 * no account here (#289).
 */
export const GHOST_HANDLE = "ghost";
const GHOST_EMAIL = "ghost@users.forgehub.invalid";

/** The ghost account, created on first use; null when a real person holds the name. */
export async function ghostUser(): Promise<{ id: string } | null> {
  const existing = await prisma.user.findUnique({ where: { handle: GHOST_HANDLE }, select: { id: true, email: true } });
  if (existing) return existing.email === GHOST_EMAIL ? { id: existing.id } : null;
  // An unusable password hash: nobody can sign in as the ghost.
  return prisma.user.create({
    data: { handle: GHOST_HANDLE, email: GHOST_EMAIL, passwordHash: "!", displayName: "Ghost", bio: "This account was deleted." },
    select: { id: true },
  });
}
