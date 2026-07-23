import type { FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";
import { hashToken } from "./tokens.js";
import { parseScopes, type PatScope } from "./scopes.js";

/**
 * Resolve a Personal Access Token presented as a Bearer credential on an API
 * request (issue #87). Returns the owning user + the token's scopes, or null when
 * the header isn't a PAT / the token is unknown or expired. Bumps `lastUsedAt`
 * best-effort. This is the API-side twin of the resolver in `routes/git-http.ts`
 * (which handles git-over-HTTP Basic auth); both feed the same scope model.
 */
export async function resolvePatBearer(
  request: FastifyRequest,
): Promise<{ userId: string; scopes: PatScope[] } | null> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  // Fast reject: our PATs are prefixed, so a JWT never reaches the DB.
  if (!token.startsWith("fhp_")) return null;

  const pat = await prisma.personalAccessToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!pat) return null;
  if (pat.expiresAt && pat.expiresAt.getTime() < Date.now()) return null;

  prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: pat.userId, scopes: parseScopes(pat.scopes) };
}
