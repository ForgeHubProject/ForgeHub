-- AlterTable
ALTER TABLE "Repo" ADD COLUMN "formats" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT false,
    "bio" TEXT,
    "location" TEXT,
    "website" TEXT,
    "pronouns" TEXT,
    "company" TEXT,
    "socialLinks" TEXT,
    "statusEmoji" TEXT,
    "statusText" TEXT,
    "statusExpiresAt" DATETIME,
    "privateProfile" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "avatarKey" TEXT
);
INSERT INTO "new_User" ("avatarKey", "bio", "company", "createdAt", "displayName", "email", "emailNotifications", "handle", "id", "location", "passwordHash", "pronouns", "socialLinks", "statusEmoji", "statusExpiresAt", "statusText", "updatedAt", "website") SELECT "avatarKey", "bio", "company", "createdAt", "displayName", "email", "emailNotifications", "handle", "id", "location", "passwordHash", "pronouns", "socialLinks", "statusEmoji", "statusExpiresAt", "statusText", "updatedAt", "website" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

