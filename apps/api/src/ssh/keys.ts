import { createHash } from "node:crypto";

/**
 * OpenSSH public-key parsing + fingerprinting (issue #116).
 *
 * Pure and dependency-free (no prisma, no ssh2) so it unit-tests trivially and the
 * transport, the CRUD routes, and the tests all share ONE definition of "what is a
 * valid key" and "what is its fingerprint". The fingerprint format matches
 * `ssh-keygen -lf`: `SHA256:` + unpadded-base64(sha256(raw key blob)), where the raw
 * blob is the base64 payload of the `type base64 [comment]` line.
 */

export type ParsedPublicKey = {
  /** Key type, e.g. "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256". */
  type: string;
  /** The base64-decoded public-key blob (what ssh2 exposes as `ctx.key.data`). */
  raw: Buffer;
  /** Trailing comment (may be empty). Never used for identity. */
  comment: string;
  /** Canonical "type base64" line with the comment stripped — what we store. */
  normalized: string;
};

/**
 * OpenSSH key types we accept. Deliberately explicit (allow-list) so junk lines are
 * rejected rather than stored. Covers ed25519, RSA, ECDSA (three curves), DSA, and
 * the FIDO/U2F security-key variants.
 */
const KEY_TYPES = new Set<string>([
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/** Read a length-prefixed SSH string (4-byte BE length + bytes) at `offset`. */
function readSSHString(buf: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  if (len < 0 || start + len > buf.length) return null;
  return { value: buf.subarray(start, start + len), next: start + len };
}

/**
 * Parse an OpenSSH public-key line ("type base64 [comment]"). Returns null for
 * anything unparseable: wrong field count, unknown type, malformed base64, or a
 * blob whose self-described type doesn't match the leading field (a strong sanity
 * check that the base64 really is a key of the claimed type).
 */
export function parsePublicKey(line: unknown): ParsedPublicKey | null {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;

  const type = parts[0];
  const b64 = parts[1];
  const comment = parts.slice(2).join(" ");

  if (!KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;

  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  // Reject base64 that decodes then re-encodes differently (non-canonical padding).
  if (raw.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) return null;

  // The blob's first field is the key type; it MUST equal the leading token.
  const embedded = readSSHString(raw, 0);
  if (!embedded || embedded.value.toString("utf8") !== type) return null;

  return { type, raw, comment, normalized: `${type} ${raw.toString("base64")}` };
}

/** `SHA256:...` fingerprint of a raw public-key blob (ssh-keygen -lf format). */
export function fingerprintFromRaw(raw: Buffer): string {
  return "SHA256:" + createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
}

/** Convenience: parse a line and return its fingerprint, or null if unparseable. */
export function computeFingerprint(line: unknown): string | null {
  const parsed = parsePublicKey(line);
  return parsed ? fingerprintFromRaw(parsed.raw) : null;
}
