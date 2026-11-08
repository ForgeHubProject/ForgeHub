-- CreateTable
CREATE TABLE "RefUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "beforeSha" TEXT,
    "afterSha" TEXT,
    "actorId" TEXT,
    "prNumber" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefUpdate_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RefUpdate_repoId_createdAt_idx" ON "RefUpdate"("repoId", "createdAt");

