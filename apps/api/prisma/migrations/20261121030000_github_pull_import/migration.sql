-- GitHub import, phase 3 (#289): pull requests and their conversations, and who wrote them on GitHub.
-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "importedAuthor" TEXT;

-- AlterTable
ALTER TABLE "PullRequestComment" ADD COLUMN "importedAuthor" TEXT;

-- AlterTable
ALTER TABLE "GithubIssueImport" ADD COLUMN "pulls" INTEGER NOT NULL DEFAULT 0;
