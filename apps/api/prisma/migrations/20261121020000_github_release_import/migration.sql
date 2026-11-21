-- GitHub import, phase 2 (#289): releases and their files, and who published them on GitHub.
-- AlterTable
ALTER TABLE "Release" ADD COLUMN "importedAuthor" TEXT;

-- AlterTable
ALTER TABLE "GithubIssueImport" ADD COLUMN "releases" INTEGER NOT NULL DEFAULT 0;
