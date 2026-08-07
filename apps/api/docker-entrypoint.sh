#!/usr/bin/env bash
set -euo pipefail

# The container runs as an unprivileged uid (see the Dockerfile's USER directive,
# issue #86). Everything below therefore has to work without root — which means the
# data volumes must already be owned by that uid.

STORAGE_ROOT="${GIT_STORAGE_ROOT:-/data/git-storage}"
CI_ROOT="${FORGEHUB_CI_ROOT:-}"

# The directory holding the SQLite database, derived from DATABASE_URL.
#
# THIS IS NOT THE SAME DIRECTORY AS $STORAGE_ROOT, and getting that wrong is the
# whole reason this function exists. On the stock stack DATABASE_URL is
# `file:/data/forgehub.db`, so the directory is /data while the git storage root is
# /data/git-storage one level below it. An operator who chowns only the git root
# would sail past a check on $STORAGE_ROOT alone and then hit EACCES inside
# `prisma migrate deploy` — because SQLite needs to create `forgehub.db-wal` and
# `forgehub.db-journal` NEXT TO the database file, which requires the containing
# directory to be writable, not just the file.
#
# Prisma resolves a relative `file:` path against the schema's directory; anything
# else (postgres://, mysql://) has no local directory at all and is skipped.
db_dir() {
  local url="${DATABASE_URL:-}"
  case "$url" in
    file:*) ;;
    *) return 0 ;;
  esac
  local p="${url#file:}"
  p="${p%%\?*}"            # strip ?connection_limit=… and friends
  [ -n "$p" ] || return 0
  case "$p" in
    /*) ;;
    *) p="/repo/apps/api/prisma/$p" ;;   # relative → resolved against the schema dir
  esac
  dirname "$p"
}

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

# The database directory FIRST: it is the one that actually stops the boot a few
# lines below, in `prisma migrate deploy`, and on the stock layout it is the PARENT
# of the git storage root — so checking it first also produces the more useful chown
# instruction (chown /data and you have fixed /data/git-storage too).
DB_DIR="$(db_dir)"
if [ -n "$DB_DIR" ]; then
  require_writable "$DB_DIR" "the database directory"
  # The DB file itself, if it already exists: a root-owned forgehub.db in an
  # otherwise-writable directory fails just as hard, and less obviously.
  DB_FILE="${DATABASE_URL#file:}"
  DB_FILE="${DB_FILE%%\?*}"
  case "$DB_FILE" in /*) ;; *) DB_FILE="/repo/apps/api/prisma/$DB_FILE" ;; esac
  if [ -e "$DB_FILE" ] && [ ! -w "$DB_FILE" ]; then
    cat >&2 <<EOF
ForgeHub: the database file ($DB_FILE) is not writable by uid $(id -u).

The API container no longer runs as root. Hand the data volume over once:

  docker compose run --rm --user 0 --entrypoint chown api -R $(id -u):$(id -g) $DB_DIR

Then start the stack again. This is a one-time migration.
EOF
    exit 1
  fi
fi

require_writable "$STORAGE_ROOT" "the git storage root"
if [ -n "$CI_ROOT" ]; then
  require_writable "$CI_ROOT" "the CI storage root"
fi

echo "Applying database migrations..."
# Call the workspace-local binary rather than `npx`: npx wants a writable npm cache
# and may attempt a network fetch, neither of which an unprivileged — possibly
# offline — container should depend on at boot.
PRISMA_BIN="npx prisma"
[ -x /repo/node_modules/.bin/prisma ] && PRISMA_BIN="/repo/node_modules/.bin/prisma"

# One upgrade case needs a human: a database built by `prisma db push` back when the
# migration history was 37 tables behind schema.prisma. It already HAS every table
# the catch-up migration creates, so `migrate deploy` stops on "table already
# exists" — correctly, but with an error that says nothing about what to do. The
# answer is to baseline: record the migration as applied without running it.
#
# Detected by failure rather than by inspecting the database, so this cannot misfire
# on a deployment that is simply broken for some other reason.
if ! $PRISMA_BIN migrate deploy; then
  cat >&2 <<'EOF'

ForgeHub: migrations did not apply.

If this database was created by an earlier ForgeHub — before the migration history
was repaired — its tables already exist and the catch-up migration has nothing to
do. Record it as applied, once, and start the stack again:

  docker compose run --rm --entrypoint /repo/node_modules/.bin/prisma api \
    migrate resolve --applied 20260807000000_catch_up_schema

Check the error above first: if it is NOT "table already exists", baselining is the
wrong answer and will hide a real problem. Your data is untouched either way —
nothing was written.
EOF
  exit 1
fi

exec "$@"
