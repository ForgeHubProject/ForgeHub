import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "fhp_";

export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
