import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem primitives for the branch-protection pre-receive hook (issue #85).
 *
 * Kept dependency-free (no prisma, no git-storage) so `createBareRepo` can
 * install the hook without an import cycle. The higher-level orchestration
 * (querying the DB, resolving storage keys) lives in `branch-protection.ts`.
 */

/** Basename of the rules file the pre-receive hook consumes (in $GIT_DIR). */
export const PROTECTION_CONFIG_BASENAME = "forgehub-protection";

/**
 * POSIX-sh pre-receive hook. Dependency-free (no node/jq) so it starts fast on
 * every push. `FORGEHUB_INTERNAL_PUSH=1` bypasses it — sanctioned server-side
 * merge pushes set that. Force-push detection uses `merge-base --is-ancestor`;
 * the pushed objects are visible in the hook's quarantine, so the new SHA
 * resolves even though refs haven't moved yet.
 */
const PRE_RECEIVE_HOOK = `#!/bin/sh
# ForgeHub branch protection — pre-receive hook. Managed by ForgeHub; do not edit.
# Rejects direct pushes, force-pushes, and deletions of protected branches.
# Rules come from the "${PROTECTION_CONFIG_BASENAME}" file in \$GIT_DIR
# (one "<branch> <flags>" line per protected branch; flags = pr,force).
[ "$FORGEHUB_INTERNAL_PUSH" = "1" ] && exit 0
GITDIR=$(git rev-parse --git-dir 2>/dev/null) || GITDIR=.
CONF="$GITDIR/${PROTECTION_CONFIG_BASENAME}"
[ -f "$CONF" ] || exit 0
ZERO=0000000000000000000000000000000000000000
rc=0
while read -r oldsha newsha ref; do
  case "$ref" in
    refs/heads/*) branch=\${ref#refs/heads/} ;;
    *) continue ;;
  esac
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
