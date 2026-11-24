-- An organization's profile, as on GitHub: website, location and avatar.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "website" TEXT;
ALTER TABLE "Organization" ADD COLUMN "location" TEXT;
ALTER TABLE "Organization" ADD COLUMN "avatarKey" TEXT;
