# Build context is the repo root (needed for npm workspaces):
#   docker build -f apps/api/Dockerfile -t forgehub-api .

FROM node:22-slim AS build
# openssl: prisma's postinstall ("prepare": "prisma generate") needs it to pick an engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# prisma/schema.prisma must exist before `npm ci` — it runs the "prepare" script (prisma generate).
COPY apps/api/prisma apps/api/prisma
RUN npm ci
COPY apps/api apps/api
WORKDIR /repo/apps/api
RUN npx prisma generate
RUN npm run build

FROM node:22-slim
# git: git-http.ts and ingest.ts shell out to the real git binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo/apps/api
ENV NODE_ENV=production

# ─── non-root (issue #86) ─────────────────────────────────────────────────────
# The API container used to run as root, so a CI step — which is a `sh -c` of
# repo-author text in this same process's OS user — was root inside the container.
# A dedicated unprivileged uid removes "root by default" and, with it, the ability
# to write outside what the app itself owns.
#
# BE CLEAR ABOUT WHAT THIS DOES NOT DO. As long as ONE process is both the API and
# the CI runner, that uid must be able to write the database and every bare repo,
# so a step running as this uid can still read and rewrite both by absolute path.
# This closes root-specific escalation; it is not a boundary between the runner and
# the forge. That only becomes true once the runner is a separate process with its
# own uid — the next stage of #86.
#
# A fixed uid/gid (not the image's stock `node`) keeps volume ownership stable and
# predictable for operators who back the volumes with host bind mounts.
ARG FORGEHUB_UID=10001
ARG FORGEHUB_GID=10001
RUN groupadd --gid "${FORGEHUB_GID}" forgehub \
    && useradd --uid "${FORGEHUB_UID}" --gid "${FORGEHUB_GID}" --create-home --home-dir /home/forgehub --shell /usr/sbin/nologin forgehub

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
COPY apps/api/package.json ./package.json
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create the mount points and hand them to the app's uid IN THE IMAGE. Docker seeds
# a freshly created named volume from the image's contents at that path, ownership
# included — so a new deployment gets correctly-owned volumes with no root-privileged
# first-boot step. An EXISTING root-owned volume is not fixed by this; the entrypoint
# detects that case and tells the operator exactly what to run (see docker-entrypoint.sh).
#   /data → SQLite DB + bare repos.   /ci → CI logs and job workspaces (separate volume).
RUN mkdir -p /data /data/git-storage /ci \
    && chown -R "${FORGEHUB_UID}:${FORGEHUB_GID}" /data /ci

# Prisma/npm want a writable HOME for caches; /home/forgehub is the user's own.
ENV HOME=/home/forgehub
ENV NPM_CONFIG_CACHE=/home/forgehub/.npm

USER ${FORGEHUB_UID}:${FORGEHUB_GID}

EXPOSE 3001
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
