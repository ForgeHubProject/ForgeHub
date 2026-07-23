import { prisma } from "./prisma.js";

/**
 * Owner resolution across the shared handle space (issue #114).
 *
 * A repo's owning namespace is either a `User` (personal) or an `Organization`
 * (org-owned). Both share ONE handle space — a handle is unique across the two
 * tables, enforced at user-register AND org-create. Routes look owners up by
 * `:handle`, so this resolver maps a handle to whichever kind claims it.
 */

export type OwnerKind = "user" | "org";

export type ResolvedOwner = { kind: OwnerKind; id: string; handle: string };

/**
 * Resolve a handle to its owning namespace, or null when unclaimed. Users are
 * checked first (the common case); at most one table can match given the shared
 * uniqueness invariant. Handles are stored lowercased, so we lowercase on the way
 * in to match.
 */
export async function resolveOwner(handle: string): Promise<ResolvedOwner | null> {
  const h = handle.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { handle: h },
    select: { id: true, handle: true },
  });
  if (user) return { kind: "user", id: user.id, handle: user.handle };
  const org = await prisma.organization.findUnique({
    where: { handle: h },
    select: { id: true, handle: true },
  });
  if (org) return { kind: "org", id: org.id, handle: org.handle };
  return null;
}

/**
 * True when `handle` is already claimed by a user OR an org. The single guard both
 * user-register and org-create consult to keep the handle space collision-free.
 */
export async function isHandleTaken(handle: string): Promise<boolean> {
  return (await resolveOwner(handle)) !== null;
}
