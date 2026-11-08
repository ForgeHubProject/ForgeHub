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
    "hasIssues" BOOLEAN NOT NULL DEFAULT true,
    "hasProjects" BOOLEAN NOT NULL DEFAULT true,
    "allowAutoMerge" BOOLEAN NOT NULL DEFAULT true,
    "autoCloseIssues" BOOLEAN NOT NULL DEFAULT true,
    "mergeCommitMessage" TEXT NOT NULL DEFAULT 'default',
    "squashCommitMessage" TEXT NOT NULL DEFAULT 'default',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "suggestUpdateBranch" BOOLEAN NOT NULL DEFAULT false,
    "formats" TEXT,
    "forkedFromId" TEXT,
    "orgId" TEXT,
    CONSTRAINT "Repo_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Repo_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "Repo" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Repo" ("allowAutoMerge", "allowedMergeMethods", "archivedAt", "autoCloseIssues", "createdAt", "defaultMergeMethod", "deleteBranchOnMerge", "description", "forkedFromId", "formats", "hasIssues", "hasProjects", "id", "lastNumber", "mergeCommitMessage", "name", "orgId", "ownerId", "squashCommitMessage", "storageKey", "updatedAt", "visibility") SELECT "allowAutoMerge", "allowedMergeMethods", "archivedAt", "autoCloseIssues", "createdAt", "defaultMergeMethod", "deleteBranchOnMerge", "description", "forkedFromId", "formats", "hasIssues", "hasProjects", "id", "lastNumber", "mergeCommitMessage", "name", "orgId", "ownerId", "squashCommitMessage", "storageKey", "updatedAt", "visibility" FROM "Repo";
DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";
CREATE UNIQUE INDEX "Repo_storageKey_key" ON "Repo"("storageKey");
CREATE UNIQUE INDEX "Repo_orgId_name_key" ON "Repo"("orgId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

