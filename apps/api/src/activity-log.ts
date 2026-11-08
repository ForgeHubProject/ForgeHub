import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma.js";

const execFile = promisify(execFileCb);

export type RefKind = "push" | "force_push" | "branch_created" | "branch_deleted" | "merge";
export const REF_KINDS: RefKind[] = ["push", "force_push", "branch_created", "branch_deleted", "merge"];

async function isAncestor(repoPath: string, older: string, newer: string): Promise<boolean> {
  try {
    await execFile("git", ["merge-base", "--is-ancestor", older, newer], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/** How a push moved each branch: created, deleted, fast-forwarded or rewritten. */
export async function classifyRefUpdates(
  repoPath: string,
  before: Map<string, string>,
  after: Map<string, string>,
): Promise<Array<{ ref: string; kind: RefKind; beforeSha: string | null; afterSha: string | null }>> {
  const out: Array<{ ref: string; kind: RefKind; beforeSha: string | null; afterSha: string | null }> = [];
  for (const [ref, sha] of after) {
    const old = before.get(ref);
    if (!old) out.push({ ref, kind: "branch_created", beforeSha: null, afterSha: sha });
    else if (old !== sha) out.push({ ref, kind: (await isAncestor(repoPath, old, sha)) ? "push" : "force_push", beforeSha: old, afterSha: sha });
  }
  for (const [ref, sha] of before) {
    if (!after.has(ref)) out.push({ ref, kind: "branch_deleted", beforeSha: sha, afterSha: null });
  }
  return out;
}

/** Log what a push did to the repository's branches (#256). */
export async function recordRefUpdates(
  repoId: string,
  repoPath: string,
  actorId: string,
  before: Map<string, string>,
  after: Map<string, string>,
): Promise<void> {
  const updates = await classifyRefUpdates(repoPath, before, after);
  if (updates.length === 0) return;
  await prisma.refUpdate.createMany({ data: updates.map((u) => ({ repoId, actorId, ...u })) });
}

/** Log a pull request merged into its base branch (#256). */
export async function recordMerge(
  repoId: string,
  ref: string,
  beforeSha: string | null,
  afterSha: string,
  actorId: string,
  prNumber: number,
): Promise<void> {
  await prisma.refUpdate.create({ data: { repoId, ref, kind: "merge", beforeSha, afterSha, actorId, prNumber } });
}
