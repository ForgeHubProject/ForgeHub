import { prisma } from "./prisma.js";

export async function resolveRepo(handle: string, name: string) {
  return prisma.repo.findFirst({
    where: { name: name.toLowerCase(), owner: { handle: handle.toLowerCase() } },
    include: {
      collaborators: { select: { userId: true, role: true } },
    },
  });
}

type RepoWithCollabs = NonNullable<Awaited<ReturnType<typeof resolveRepo>>>;

export function canRead(repo: RepoWithCollabs, userId: string | undefined): boolean {
  if (repo.visibility === "PUBLIC") return true;
  if (!userId) return false;
  if (repo.ownerId === userId) return true;
  return repo.collaborators.some((c) => c.userId === userId);
}

export function canWrite(repo: RepoWithCollabs, userId: string | undefined): boolean {
  if (!userId) return false;
  if (repo.ownerId === userId) return true;
  return repo.collaborators.some((c) => c.userId === userId && c.role === "WRITER");
}
