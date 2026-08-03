-- Add lastUsedIp to SSHKey and lastUsedAt/lastUsedIp to DeployKey (issue #156)
ALTER TABLE "SSHKey" ADD COLUMN "lastUsedIp" TEXT;
ALTER TABLE "DeployKey" ADD COLUMN "lastUsedAt" DATETIME;
ALTER TABLE "DeployKey" ADD COLUMN "lastUsedIp" TEXT;
