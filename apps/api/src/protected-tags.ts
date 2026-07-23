import { prisma } from "./prisma.js";
import { bareRepoPathFromKey } from "./git-storage.js";
import { writeProtectedTagsConfig } from "./git-hooks.js";
import { globMatch } from "./ci/workflows.js";

/**
 * Protected tags (issue #117).
 *
 * Mirrors branch protection's two-path enforcement (issue #85):
 *  (a) the git transport — the shared pre-receive hook (see `git-hooks.ts`) reads
 *      a `forgehub-protected-tags` rules file and rejects deletes/overwrites of a
 *      tag whose name matches a protected glob pattern; and
 *  (b) the API tag routes — `routes/tags.ts` refuses to delete or overwrite a
 *      matching tag.
 *
 * The DB is the source of truth; the rules file is regenerated from it whenever a
 * pattern changes and on every push (via `preparePushProtection`). Creating a
 * brand-new matching tag stays allowed, so releases keep working.
 */

/** Does `tag` match a protected glob `pattern`? `*` matches within a path segment. */
export function tagMatchesPattern(pattern: string, tag: string): boolean {
  return globMatch(pattern, tag);
}

/** Is `tag` covered by any of the protected `patterns`? */
export function isTagProtected(patterns: string[], tag: string): boolean {
  return patterns.some((p) => tagMatchesPattern(p, tag));
}

/** The protected-tag glob patterns configured for a repo. */
export async function protectedTagPatterns(repoId: string): Promise<string[]> {
  const rows = await prisma.protectedTag.findMany({
    where: { repoId },
    select: { pattern: true },
  });
  return rows.map((r) => r.pattern);
}

/** Regenerate a repo's protected-tags rules file from the database (source of truth). */
export async function syncProtectedTagsConfig(repoId: string, storageKey: string): Promise<void> {
  const patterns = await protectedTagPatterns(repoId);
  await writeProtectedTagsConfig(bareRepoPathFromKey(storageKey), patterns);
}
