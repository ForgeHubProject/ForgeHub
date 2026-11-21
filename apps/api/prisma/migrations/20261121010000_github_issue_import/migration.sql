-- GitHub import, phase 2 (#289): labels, milestones, issues and comments, and who wrote them on GitHub.
-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "importedAuthor" TEXT;

-- AlterTable
ALTER TABLE "IssueComment" ADD COLUMN "importedAuthor" TEXT;

-- CreateTable
CREATE TABLE "GithubIssueImport" (
    "repoId" TEXT NOT NULL PRIMARY KEY,
    "stage" TEXT NOT NULL DEFAULT 'labels',
    "page" INTEGER NOT NULL DEFAULT 1,
    "issues" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "waitUntil" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GithubIssueImport_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
