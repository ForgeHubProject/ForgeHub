/**
 * GitHub's keyboard shortcuts (#255), as pure functions: which repository a
 * path is in, and what a key sequence does there.
 */

/** First path segments that are site pages, never an owner. */
const SITE_PAGES = new Set(["settings", "orgs", "organizations", "search", "notifications", "feed", "issues", "pulls", "login"]);

/** The repository a path is inside (`/owner/name/...`), or null. */
export function repoFromPath(pathname: string): { owner: string; name: string } | null {
  const [owner, name] = pathname.split("/").filter(Boolean);
  if (!owner || !name || SITE_PAGES.has(owner)) return null;
  return { owner, name };
}

export type ShortcutAction =
  | { kind: "navigate"; to: string }
  | { kind: "focus"; selector: string }
  | { kind: "help" }
  /** The first key of a two-key sequence ("g"): wait for the next. */
  | { kind: "pending" };

/** The help dialog's list, and the source of truth for what's bound. */
export const SHORTCUTS: Array<{ keys: string; what: string; where: "site" | "repo" }> = [
  { keys: "/", what: "Focus the search bar", where: "site" },
  { keys: "g d", what: "Go to your dashboard", where: "site" },
  { keys: "g n", what: "Go to your notifications", where: "site" },
  { keys: "g i", what: "Go to issues (this repository's, or yours)", where: "site" },
  { keys: "g p", what: "Go to pull requests (this repository's, or yours)", where: "site" },
  { keys: "?", what: "Show these shortcuts", where: "site" },
  { keys: "t", what: "Find a file", where: "repo" },
  { keys: "g c", what: "Go to the code", where: "repo" },
  { keys: "g a", what: "Go to Actions", where: "repo" },
  { keys: "g b", what: "Go to projects", where: "repo" },
];

/**
 * What `keys` (the sequence so far, e.g. ["g", "i"]) does at `pathname`, or
 * null for nothing. Inside a repository g i / g p mean its issues and pull
 * requests; elsewhere, yours.
 */
export function resolveShortcut(keys: string[], pathname: string): ShortcutAction | null {
  const repo = repoFromPath(pathname);
  const base = repo ? `/${repo.owner}/${repo.name}` : null;
  const [first, second] = keys;
  if (keys.length === 1) {
    if (first === "/") return { kind: "focus", selector: "#global-search" };
    if (first === "?") return { kind: "help" };
    if (first === "g") return { kind: "pending" };
    if (first === "t" && base) return { kind: "focus", selector: "[data-shortcut='go-to-file']" };
    return null;
  }
  if (first !== "g" || keys.length !== 2) return null;
  switch (second) {
    case "d": return { kind: "navigate", to: "/" };
    case "n": return { kind: "navigate", to: "/notifications" };
    case "i": return { kind: "navigate", to: base ? `${base}/issues` : "/issues" };
    case "p": return { kind: "navigate", to: base ? `${base}/pulls` : "/pulls" };
    case "c": return base ? { kind: "navigate", to: base } : null;
    case "a": return base ? { kind: "navigate", to: `${base}/actions` } : null;
    case "b": return base ? { kind: "navigate", to: `${base}/projects` } : null;
    default: return null;
  }
}
