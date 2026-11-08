-- CreateTable
CREATE TABLE "ThreadMute" (
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "subjectId"),
    CONSTRAINT "ThreadMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectTitle" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("createdAt", "id", "read", "reason", "repoId", "subjectId", "subjectTitle", "subjectType", "updatedAt", "userId") SELECT "createdAt", "id", "read", "reason", "repoId", "subjectId", "subjectTitle", "subjectType", "updatedAt", "userId" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE UNIQUE INDEX "Notification_userId_subjectId_key" ON "Notification"("userId", "subjectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

