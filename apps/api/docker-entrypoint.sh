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

# ── Detect database provider from DATABASE_URL ────────────────────────────────
db_provider() {
  local url="${DATABASE_URL:-}"
  case "$url" in
    postgres://*|postgresql://*) echo "postgresql" ;;
    mysql://*)                   echo "mysql" ;;
    *)                           echo "sqlite" ;;
  esac
}

# Ensure DATABASE_PROVIDER is set — Prisma reads it at runtime via env("DATABASE_PROVIDER").
# In Docker deployments the compose file sets it explicitly; bare-metal users may omit it,
# in which case we derive it from DATABASE_URL.
if [ -z "${DATABASE_PROVIDER:-}" ]; then
  export DATABASE_PROVIDER="$(db_provider)"
fi

# ── Wait for external DB to accept TCP connections ────────────────────────────
# SQLite is local — nothing to wait for.  PostgreSQL/MySQL containers need a
# few seconds to initialise; we probe the TCP port rather than shipping extra
# client binaries.  Bash's /dev/tcp is a built-in and works in every image.
wait_for_db() {
  local url="${DATABASE_URL:-}"
  local default_port provider host port parsed

  case "$(db_provider)" in
    postgresql) default_port=5432 ;;
    mysql)      default_port=3306 ;;
    *)          return 0 ;;   # SQLite — nothing to wait for
  esac

  provider="$(db_provider)"

  # Extract host and port using the Node.js URL parser (already in the image).
  parsed=$(node -e "
    try {
      const u = new URL(process.argv[1]);
      process.stdout.write(u.hostname + ':' + (u.port || process.argv[2]));
    } catch(e) { process.exit(1); }
  " "$url" "$default_port" 2>/dev/null) || {
    echo "ForgeHub: could not parse DATABASE_URL for $provider" >&2
    exit 1
  }
  host="${parsed%%:*}"
  port="${parsed##*:}"

  echo "Waiting for $provider at $host:$port..."
  local tries=60
  while ! (echo >/dev/tcp/"$host"/"$port") 2>/dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -eq 0 ]; then
      echo "ForgeHub: timed out waiting for $provider at $host:$port" >&2
      exit 1
    fi
    sleep 2
  done
  echo "$provider is ready."
}

wait_for_db

echo "Applying database migrations..."
# Call the workspace-local binary rather than `npx`: npx wants a writable npm cache
# and may attempt a network fetch, neither of which an unprivileged — possibly
# offline — container should depend on at boot.
PRISMA_BIN="npx prisma"
[ -x /repo/node_modules/.bin/prisma ] && PRISMA_BIN="/repo/node_modules/.bin/prisma"

case "$(db_provider)" in
  sqlite)
    # SQLite: replay the SQL migration files (existing behaviour — SQLite-specific
    # SQL that was generated by `prisma migrate dev`).
    #
    # One upgrade case needs a human: a database built by `prisma db push` back
    # when the migration history was 37 tables behind schema.prisma already HAS
    # every table the catch-up migration creates, so `migrate deploy` stops on
    # "table already exists" — correctly, but with an error that says nothing about
    # what to do.  The answer is to baseline: record the migration as applied.
    #
    # Detected by failure rather than by inspecting the database, so this cannot
    # misfire on a deployment that is simply broken for some other reason.
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
    ;;

  postgresql|mysql)
    # PostgreSQL / MySQL: the migration files contain SQLite SQL and cannot be
    # replayed on these providers.  `db push` generates correct provider-specific
    # DDL directly from schema.prisma — idempotent, safe for additive changes.
    #
    # For DESTRUCTIVE schema changes (dropped/renamed column or table) run once:
    #   docker compose run --rm forgehub /usr/local/bin/docker-entrypoint.sh \
    #     /repo/node_modules/.bin/prisma db push --accept-data-loss
    # Back up your data first.
    if ! $PRISMA_BIN db push; then
      cat >&2 <<'EOF'

ForgeHub: schema push did not apply.

If the schema change would destroy data (dropped column, incompatible type),
Prisma requires explicit confirmation.  Back up your data, then run:

  docker compose run --rm forgehub \
    /repo/node_modules/.bin/prisma db push --accept-data-loss

EOF
      exit 1
    fi
    ;;
esac

exec "$@"
