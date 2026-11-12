import type { User } from "../types";

/**
 * A signed-out visitor. Public pages render for them with an empty token and
 * this user: no id and no handle, so no ownership or permission check passes,
 * and the API answers with what anyone may see.
 */
export const GUEST: User = { id: "", handle: "", email: "", displayName: null };

export function isGuest(user: User | null | undefined): boolean {
  return !user?.id;
}

/** Where to go after signing in: a path on this site, never another origin. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

/** The sign-in page, coming back to `next` (default: where the visitor is now). */
export function signInPath(next?: string, mode?: "register"): string {
  const here = next ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const params = new URLSearchParams({ next: safeNext(here) });
  if (mode) params.set("mode", mode);
  return `/login?${params}`;
}
