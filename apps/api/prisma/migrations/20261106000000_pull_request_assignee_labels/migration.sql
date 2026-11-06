-- CreateTable
CREATE TABLE "PullRequestLabel" (
    "pullRequestId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,

    PRIMARY KEY ("pullRequestId", "labelId"),
    CONSTRAINT "PullRequestLabel_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PullRequestLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PullRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fromBranch" TEXT NOT NULL,
    "toBranch" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "mergedAt" DATETIME,
    "mergeMethod" TEXT,
    "mergeCommitSha" TEXT,
    "baseSha" TEXT,
    "headSha" TEXT,
    "autoMergeMethod" TEXT,
    "autoMergeById" TEXT,
    "authorId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "assigneeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PullRequest_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PullRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PullRequest_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PullRequest_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PullRequest" ("authorId", "autoMergeById", "autoMergeMethod", "baseSha", "createdAt", "description", "fromBranch", "headSha", "id", "isDraft", "mergeCommitSha", "mergeMethod", "mergedAt", "milestoneId", "number", "repoId", "state", "title", "toBranch", "updatedAt") SELECT "authorId", "autoMergeById", "autoMergeMethod", "baseSha", "createdAt", "description", "fromBranch", "headSha", "id", "isDraft", "mergeCommitSha", "mergeMethod", "mergedAt", "milestoneId", "number", "repoId", "state", "title", "toBranch", "updatedAt" FROM "PullRequest";
DROP TABLE "PullRequest";
ALTER TABLE "new_PullRequest" RENAME TO "PullRequest";
CREATE UNIQUE INDEX "PullRequest_repoId_number_key" ON "PullRequest"("repoId", "number");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

