import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two-factor authentication (#258): RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps)
 * from an authenticator app, and single-use recovery codes.
 *
 * The TOTP secret is stored AES-256-GCM-encrypted under a key derived from
 * JWT_SECRET, so a copy of the database alone doesn't hand out everyone's second
 * factor. Rotating JWT_SECRET makes the stored secrets unreadable: those users
 * sign in with a recovery code, then turn two-factor off and on again.
 */

export const TOTP_STEP_SECONDS = 30;

/** The time step `ms` falls in. */
export function totpStep(ms = Date.now()): number {
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

/** The 6-digit HOTP (RFC 4226) code of `secret` at counter `step`. */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * The step `code` is valid for — the current one or a neighbour, for clock
 * drift — or null. A step at or before `lastStep` (already used) never counts.
 */
export function matchTotp(secret: Buffer, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const t = totpStep(now);
  let matched: number | null = null;
  for (const step of [t - 1, t, t + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** A new 160-bit TOTP secret (RFC 4226's recommended length). */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding, the form authenticator apps take. */
export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The otpauth:// URI authenticator apps import (Google's Key Uri Format). */
export function otpauthUri(secret: Buffer, handle: string): string {
  return `otpauth://totp/ForgeHub:${encodeURIComponent(handle)}?secret=${base32(secret)}&issuer=ForgeHub&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}

function secretKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", process.env["JWT_SECRET"] ?? "", "", "forgehub totp secret", 32));
}

/** `iv.tag.ciphertext`, base64url. */
export function encryptSecret(secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

/** The secret, or null when it can't be read (JWT_SECRET changed, or tampered). */
export function decryptSecret(stored: string): Buffer | null {
  try {
    const [iv, tag, ct] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

/** Ten recovery codes, 80 bits each, as `xxxxx-xxxxx-xxxxx-xxxxx`. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(10).toString("hex").match(/.{5}/g)!.join("-"));
}

/** What's stored for a recovery code; case, dashes and spaces don't matter. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toLowerCase().replace(/[^0-9a-f]/g, "")).digest("hex");
}
