-- AlterTable
ALTER TABLE "SSHKey" ADD COLUMN "lastUsedIp" TEXT;

-- AlterTable
ALTER TABLE "DeployKey" ADD COLUMN "lastUsedAt" DATETIME;
ALTER TABLE "DeployKey" ADD COLUMN "lastUsedIp" TEXT;
