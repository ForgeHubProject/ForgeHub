/**
 * Personal access token scopes (issue #87).
 *
 * A PAT is no longer an all-or-nothing credential: `PersonalAccessToken.scopes`
 * is a comma-separated subset of {@link PAT_SCOPES}. Scopes form a small
 * hierarchy — `admin` implies write+read, `repo:write` implies read — so a route
 * asks for the *least* scope it needs and higher scopes satisfy it.
 *
 * Session credentials (a login JWT) are NOT scoped: a human logged into the UI
 * has full power. Only PAT-authenticated requests carry a scope set; the auth
 * layer leaves `request.patScopes` null for JWT sessions, and the `requireScope`
 * preHandler treats null as "full access". The same helper backs the git-http
 * write path (a push needs `repo:write`).
 */

export const PAT_SCOPES = ["repo:read", "repo:write", "admin"] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

/** Full scope set — the default for tokens minted before scopes existed. */
export const FULL_SCOPES: PatScope[] = ["repo:read", "repo:write", "admin"];

function isPatScope(s: string): s is PatScope {
  return (PAT_SCOPES as readonly string[]).includes(s);
}

/** Parse the stored comma-separated column into a validated scope list. */
export function parseScopes(raw: string | null | undefined): PatScope[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(isPatScope);
}

/** Serialize a scope list back to the stored column form (deduped, ordered). */
export function serializeScopes(scopes: PatScope[]): string {
  const set = new Set(scopes.filter(isPatScope));
  return PAT_SCOPES.filter((s) => set.has(s)).join(",");
}

/**
 * Validate + normalize a caller-supplied scope list (from token creation).
 * Drops unknown entries; falls back to the full set when nothing valid is given,
 * so a token is never created powerless by accident.
 */
export function normalizeRequestedScopes(input: unknown): PatScope[] {
  if (!Array.isArray(input)) return [...FULL_SCOPES];
  const valid = input.filter((s): s is PatScope => typeof s === "string" && isPatScope(s));
  const deduped = PAT_SCOPES.filter((s) => valid.includes(s));
  return deduped.length > 0 ? deduped : [...FULL_SCOPES];
}

/**
 * Does `scopes` grant `required`, honoring the hierarchy
 * (`admin` ⊇ `repo:write` ⊇ `repo:read`)?
 */
export function hasScope(scopes: PatScope[], required: PatScope): boolean {
  if (scopes.includes(required)) return true;
  if (scopes.includes("admin")) return true; // admin grants everything
  if (required === "repo:read" && scopes.includes("repo:write")) return true;
  return false;
}
