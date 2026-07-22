import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, stateless one-click unsubscribe tokens.
 *
 * A token is `base64url(userId).base64url(HMAC-SHA256(userId))`. It carries the
 * user id and a signature, so the unsubscribe endpoint needs no auth and no
 * stored nonce — a tampered id or signature simply fails verification. The
 * secret comes from `UNSUBSCRIBE_SECRET` (falling back to `JWT_SECRET`, then a
 * fixed dev constant) so links stay valid across restarts of a given instance.
 */

function secret(): string {
  return (
    process.env["UNSUBSCRIBE_SECRET"]?.trim() ||
    process.env["JWT_SECRET"]?.trim() ||
    "forgehub-dev-unsubscribe-secret"
  );
}

function sign(userId: string): Buffer {
  return createHmac("sha256", secret()).update(userId).digest();
}

/** Build an unsubscribe token for a user. */
export function signUnsubscribeToken(userId: string): string {
  const id = Buffer.from(userId, "utf8").toString("base64url");
  const sig = sign(userId).toString("base64url");
  return `${id}.${sig}`;
}

/** Verify a token, returning the user id when valid, or `null` otherwise. */
export function verifyUnsubscribeToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  let userId: string;
  try {
    userId = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!userId) return null;

  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }

  const expected = sign(userId);
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? userId : null;
}
