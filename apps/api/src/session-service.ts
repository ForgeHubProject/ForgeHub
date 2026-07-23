import { prisma } from "./prisma.js";

/**
 * Interactive-login session enforcement (issue #117).
 *
 * The login/register handlers record a `Session` row and embed its id as the
 * JWT's `sid` claim. On every authenticated request the auth preHandler calls
 * `sessionActive(sid)`: a revoked (or vanished) session fails closed, and a live
 * one has its `lastSeenAt` stamped — throttled to at most one write per minute so
 * a busy client doesn't turn every request into a DB write.
 *
 * Tokens without a `sid` (Personal Access Tokens, or JWTs minted before this
 * feature) never reach here; callers skip the check when `sid` is absent, so
 * pre-upgrade logins keep working (they just can't be revoked individually).
 */

/** Minimum gap between `lastSeenAt` writes for one session. */
export const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * True when the session `sid` is live (exists and not revoked). Side effect:
 * refreshes `lastSeenAt` when it is older than {@link LAST_SEEN_THROTTLE_MS}
 * (fire-and-forget — a stamp failure never blocks the request).
 */
export async function sessionActive(sid: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sid } });
  if (!session || session.revokedAt) return false;
  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    void prisma.session
      .update({ where: { id: sid }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }
  return true;
}
