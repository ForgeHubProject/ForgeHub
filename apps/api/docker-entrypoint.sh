#!/usr/bin/env bash
set -euo pipefail

# The container runs as an unprivileged uid (see the Dockerfile's USER directive,
# issue #86). Everything below therefore has to work without root — which means the
# data volumes must already be owned by that uid.

STORAGE_ROOT="${GIT_STORAGE_ROOT:-/data/git-storage}"
CI_ROOT="${FORGEHUB_CI_ROOT:-}"

# Fail fast, and actionably, on the one upgrade hazard: a volume created by an
# older ROOT-running image is still owned by root, and this uid cannot write it.
# Docker only seeds ownership from the image when it CREATES a volume, so an
# existing volume keeps whatever it had. Better a clear message now than a pile of
# EACCES stack traces out of Prisma five seconds later.
require_writable() {
  local dir="$1" label="$2"
  mkdir -p "$dir" 2>/dev/null || true
  if [ ! -w "$dir" ]; then
    cat >&2 <<EOF
ForgeHub: $label ($dir) is not writable by uid $(id -u).

The API container no longer runs as root. A volume created by an earlier ForgeHub
image is still owned by root and has to be handed over once:

  docker compose run --rm --user 0 --entrypoint chown api -R $(id -u):$(id -g) $dir

Then start the stack again. This is a one-time migration.
EOF
    exit 1
  fi
}

require_writable "$STORAGE_ROOT" "the git storage root"
if [ -n "$CI_ROOT" ]; then
  require_writable "$CI_ROOT" "the CI storage root"
fi

echo "Applying database migrations..."
# Call the workspace-local binary rather than `npx`: npx wants a writable npm cache
# and may attempt a network fetch, neither of which an unprivileged — possibly
# offline — container should depend on at boot.
if [ -x /repo/node_modules/.bin/prisma ]; then
  /repo/node_modules/.bin/prisma migrate deploy
else
  npx prisma migrate deploy
fi

exec "$@"
