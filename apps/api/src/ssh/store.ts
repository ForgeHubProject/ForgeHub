import { prisma } from "../prisma.js";

/**
 * Prisma-backed lookups for SSH credentials (issue #116). Kept apart from the pure
 * parsing in `keys.ts` so that module stays trivially unit-testable.
 */

/**
 * Is a fingerprint already claimed by ANY credential? A fingerprint is unique per
 * table via `@unique`, but a key must be unique across BOTH tables (a single key
 * can back at most one SSHKey or DeployKey anywhere), so creation checks both.
 */
export async function fingerprintInUse(fingerprint: string): Promise<boolean> {
  const [asSshKey, asDeployKey] = await Promise.all([
    prisma.sSHKey.findUnique({ where: { fingerprint }, select: { id: true } }),
    prisma.deployKey.findUnique({ where: { fingerprint }, select: { id: true } }),
  ]);
  return Boolean(asSshKey || asDeployKey);
}

/**
 * The authenticated SSH actor, resolved from a presented public key's fingerprint.
 * A `user` actor (SSHKey) acts with its owner's full repo access; a `deploy` actor
 * (DeployKey) is repo-scoped and honors `readOnly`.
 */
export type SshActor =
  | { kind: "user"; userId: string; sshKeyId: string; publicKey: string }
  | { kind: "deploy"; deployKeyId: string; repoId: string; readOnly: boolean; publicKey: string };

/** Look up an actor by fingerprint: SSHKey first, then DeployKey. Null if neither. */
export async function resolveActorByFingerprint(fingerprint: string): Promise<SshActor | null> {
  const sshKey = await prisma.sSHKey.findUnique({ where: { fingerprint } });
  if (sshKey) {
    return { kind: "user", userId: sshKey.userId, sshKeyId: sshKey.id, publicKey: sshKey.publicKey };
  }
  const deployKey = await prisma.deployKey.findUnique({ where: { fingerprint } });
  if (deployKey) {
    return {
      kind: "deploy",
      deployKeyId: deployKey.id,
      repoId: deployKey.repoId,
      readOnly: deployKey.readOnly,
      publicKey: deployKey.publicKey,
    };
  }
  return null;
}

/** Best-effort `lastUsedAt` bump for a user SSH key on successful auth. */
export function touchSshKey(sshKeyId: string): void {
  prisma.sSHKey.update({ where: { id: sshKeyId }, data: { lastUsedAt: new Date() } }).catch(() => {});
}
