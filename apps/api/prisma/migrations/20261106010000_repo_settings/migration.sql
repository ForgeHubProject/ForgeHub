-- CreateTable
CREATE TABLE "RepoRedirect" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerHandle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepoRedirect_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "storageKey" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "allowedMergeMethods" TEXT NOT NULL DEFAULT 'merge,squash,rebase',
    "defaultMergeMethod" TEXT NOT NULL DEFAULT 'merge',
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "deleteBranchOnMerge" BOOLEAN NOT NULL DEFAULT false,
    "forkedFromId" TEXT,
    "orgId" TEXT,
    CONSTRAINT "Repo_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Repo_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "Repo" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Repo" ("allowedMergeMethods", "createdAt", "defaultMergeMethod", "description", "forkedFromId", "id", "lastNumber", "name", "orgId", "ownerId", "storageKey", "updatedAt", "visibility") SELECT "allowedMergeMethods", "createdAt", "defaultMergeMethod", "description", "forkedFromId", "id", "lastNumber", "name", "orgId", "ownerId", "storageKey", "updatedAt", "visibility" FROM "Repo";
DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";
CREATE UNIQUE INDEX "Repo_storageKey_key" ON "Repo"("storageKey");
CREATE UNIQUE INDEX "Repo_orgId_name_key" ON "Repo"("orgId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RepoRedirect_ownerHandle_name_key" ON "RepoRedirect"("ownerHandle", "name");

