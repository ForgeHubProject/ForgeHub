import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem primitives for the branch-protection pre-receive hook (issue #85).
 *
 * Kept dependency-free (no prisma, no git-storage) so `createBareRepo` can
 * install the hook without an import cycle. The higher-level orchestration
 * (querying the DB, resolving storage keys) lives in `branch-protection.ts`.
 */

/** Basename of the branch-rules file the pre-receive hook consumes (in $GIT_DIR). */
export const PROTECTION_CONFIG_BASENAME = "forgehub-protection";

/** Basename of the protected-tags rules file the pre-receive hook consumes (in $GIT_DIR). */
export const PROTECTED_TAGS_CONFIG_BASENAME = "forgehub-protected-tags";

/**
 * POSIX-sh pre-receive hook. Dependency-free (no node/jq) so it starts fast on
 * every push. `FORGEHUB_INTERNAL_PUSH=1` bypasses it — sanctioned server-side
 * merge pushes set that. Force-push detection uses `merge-base --is-ancestor`;
 * the pushed objects are visible in the hook's quarantine, so the new SHA
 * resolves even though refs haven't moved yet.
 *
 * Enforces two policies from files next to the git dir (both optional):
 *  - branch protection ("${PROTECTION_CONFIG_BASENAME}", issue #85): rejects direct
 *    pushes, force-pushes, and deletions of protected branches;
 *  - tag protection ("${PROTECTED_TAGS_CONFIG_BASENAME}", issue #117): rejects
 *    deletion or overwrite/move of a tag matching a protected glob pattern, while
 *    still allowing brand-new matching tags (so releases keep working).
 */
const PRE_RECEIVE_HOOK = `#!/bin/sh
# ForgeHub protection — pre-receive hook. Managed by ForgeHub; do not edit.
# Branch rules: "${PROTECTION_CONFIG_BASENAME}" (one "<branch> <flags>" line; flags = pr,force).
# Tag rules:    "${PROTECTED_TAGS_CONFIG_BASENAME}" (one "<glob-pattern>" line; * wildcard).
[ "$FORGEHUB_INTERNAL_PUSH" = "1" ] && exit 0
GITDIR=$(git rev-parse --git-dir 2>/dev/null) || GITDIR=.
CONF="$GITDIR/${PROTECTION_CONFIG_BASENAME}"
TAGCONF="$GITDIR/${PROTECTED_TAGS_CONFIG_BASENAME}"
[ -f "$CONF" ] || [ -f "$TAGCONF" ] || exit 0
ZERO=0000000000000000000000000000000000000000
rc=0
while read -r oldsha newsha ref; do
  case "$ref" in
    refs/heads/*)
      [ -f "$CONF" ] || continue
      branch=\${ref#refs/heads/}
      found=0
      flags=
      while read -r b f; do
        if [ "$b" = "$branch" ]; then found=1; flags=$f; break; fi
      done < "$CONF"
      [ "$found" = 0 ] && continue
      if [ "$newsha" = "$ZERO" ]; then
        printf 'Branch protection: "%s" is a protected branch and cannot be deleted.\\n' "$branch" >&2
        rc=1; continue
      fi
      case ",$flags," in
        *,pr,*)
          printf 'Branch protection: "%s" is protected — direct pushes are blocked. Open a pull request to merge your changes.\\n' "$branch" >&2
          rc=1; continue ;;
      esac
      case ",$flags," in
        *,force,*)
          if [ "$oldsha" != "$ZERO" ] && ! git merge-base --is-ancestor "$oldsha" "$newsha" 2>/dev/null; then
            printf 'Branch protection: non-fast-forward (force) push to "%s" is blocked.\\n' "$branch" >&2
            rc=1; continue
          fi ;;
      esac
      ;;
    refs/tags/*)
      [ -f "$TAGCONF" ] || continue
      tag=\${ref#refs/tags/}
      # Guard deletes (new = zero) and overwrites/moves of an existing tag
      # (old != zero). Creating a fresh matching tag is always allowed.
      if [ "$newsha" = "$ZERO" ] || [ "$oldsha" != "$ZERO" ]; then
        while read -r pattern; do
          [ -z "$pattern" ] && continue
          case "$tag" in
            $pattern)
              if [ "$newsha" = "$ZERO" ]; then
                printf 'Tag protection: "%s" is a protected tag and cannot be deleted.\\n' "$tag" >&2
              else
                printf 'Tag protection: "%s" is a protected tag and cannot be moved or overwritten.\\n' "$tag" >&2
              fi
              rc=1; break ;;
          esac
        done < "$TAGCONF"
      fi
      ;;
    *) continue ;;
  esac
done
exit $rc
`;

/** Install (or refresh) the pre-receive hook in a bare repo. Idempotent. */
export async function installPreReceiveHook(bareRepoPath: string): Promise<void> {
  const hooksDir = path.join(bareRepoPath, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-receive");
  await writeFile(hookPath, PRE_RECEIVE_HOOK, { mode: 0o755 });
  // writeFile's mode is masked by umask; force the exec bits explicitly.
  await chmod(hookPath, 0o755);
}

export type ProtectionConfigEntry = {
  branch: string;
  requirePullRequest: boolean;
  blockForcePush: boolean;
};

/**
 * Write the rules file the hook reads. Every protected branch gets a line (so
 * deletion is blocked even with no push flags); an empty set removes the file.
 */
export async function writeProtectionConfig(
  bareRepoPath: string,
  entries: ProtectionConfigEntry[],
): Promise<void> {
  const file = path.join(bareRepoPath, PROTECTION_CONFIG_BASENAME);
  if (entries.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const lines = entries.map((e) => {
    const flags = [e.requirePullRequest ? "pr" : null, e.blockForcePush ? "force" : null]
      .filter(Boolean)
      .join(",");
    return flags ? `${e.branch} ${flags}` : e.branch;
  });
  await writeFile(file, lines.join("\n") + "\n", "utf8");
}

/**
 * Write the protected-tags rules file the hook reads (one glob pattern per line).
 * An empty set removes the file (mirrors {@link writeProtectionConfig}).
 */
export async function writeProtectedTagsConfig(
  bareRepoPath: string,
  patterns: string[],
): Promise<void> {
  const file = path.join(bareRepoPath, PROTECTED_TAGS_CONFIG_BASENAME);
  const cleaned = patterns.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await writeFile(file, cleaned.join("\n") + "\n", "utf8");
}
