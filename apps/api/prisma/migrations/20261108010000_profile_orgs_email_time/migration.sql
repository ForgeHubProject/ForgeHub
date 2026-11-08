-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OrgMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "public" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OrgMembership" ("createdAt", "id", "orgId", "role", "userId") SELECT "createdAt", "id", "orgId", "role", "userId" FROM "OrgMembership";
DROP TABLE "OrgMembership";
ALTER TABLE "new_OrgMembership" RENAME TO "OrgMembership";
CREATE INDEX "OrgMembership_userId_idx" ON "OrgMembership"("userId");
CREATE UNIQUE INDEX "OrgMembership_orgId_userId_key" ON "OrgMembership"("orgId", "userId");
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
    "showEmail" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "notificationPrefs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "avatarKey" TEXT
);
INSERT INTO "new_User" ("avatarKey", "bio", "company", "createdAt", "displayName", "email", "emailNotifications", "handle", "id", "location", "notificationPrefs", "passwordHash", "privateProfile", "pronouns", "socialLinks", "statusEmoji", "statusExpiresAt", "statusText", "updatedAt", "website") SELECT "avatarKey", "bio", "company", "createdAt", "displayName", "email", "emailNotifications", "handle", "id", "location", "notificationPrefs", "passwordHash", "privateProfile", "pronouns", "socialLinks", "statusEmoji", "statusExpiresAt", "statusText", "updatedAt", "website" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

