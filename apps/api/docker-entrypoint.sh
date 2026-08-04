#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${GIT_STORAGE_ROOT:-/data/git-storage}"

echo "Applying database schema..."
npx prisma db push --accept-data-loss

exec "$@"
