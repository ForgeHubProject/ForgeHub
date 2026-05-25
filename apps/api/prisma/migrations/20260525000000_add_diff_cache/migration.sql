-- CreateTable
CREATE TABLE "DiffCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handlerId" TEXT NOT NULL,
    "baseBlobSha" TEXT NOT NULL,
    "headBlobSha" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DiffCache_handlerId_baseBlobSha_headBlobSha_key" ON "DiffCache"("handlerId", "baseBlobSha", "headBlobSha");
