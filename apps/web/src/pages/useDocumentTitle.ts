import { useEffect } from "react";

/**
 * The app-wide default document title. Pages that set their own title via
 * {@link useDocumentTitle} restore to this when they unmount, and `App` seeds
 * it on first paint, so any route that does not claim a title falls back here.
 */
export const DEFAULT_TITLE = "ForgeHub";

/**
 * Sets `document.title` for the lifetime of the calling page and restores the
 * app default ({@link DEFAULT_TITLE}) on unmount. Pass a fully composed title
 * string, e.g. `"Sign in · ForgeHub"` or `"owner/repo · ForgeHub"`.
 *
 * Pattern for page agents: call this once near the top of a page component with
 * a route-specific title. Pages that never call it inherit the app default. A
 * page with dynamic data builds the string itself, e.g.:
 *
 * ```tsx
 * useDocumentTitle(repo ? `${repo.ownerHandle}/${repo.name} · ForgeHub` : DEFAULT_TITLE);
 * ```
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
