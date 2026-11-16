-- Social preview image (#256): a cache-busting key; the bytes live on disk.
ALTER TABLE "Repo" ADD COLUMN "socialPreviewKey" TEXT;
