-- Import a repository from GitHub (#289): where it came from and the import job's state.
ALTER TABLE "Repo" ADD COLUMN "importSource" TEXT;
ALTER TABLE "Repo" ADD COLUMN "importStatus" TEXT;
ALTER TABLE "Repo" ADD COLUMN "importError" TEXT;
