# Combined ForgeHub image — API (Node.js :3001) + Web (nginx :80) in one container.
# supervisord manages both processes; nginx proxies API paths to localhost:3001.
#
# Build:
#   docker build -t forgehub .
#   podman build -t forgehub .
#
# Security model: supervisord and both sub-processes run as root inside the
# container. This is the standard trade-off for a combined single-container
# image — cross-process uid isolation only matters between containers, not
# within one. Use the separate apps/api/Dockerfile + apps/web/Dockerfile with
# docker-compose.yml if you prefer the two-container layout.

# ── API build ──────────────────────────────────────────────────────────────────
FROM docker.io/library/node:22-slim AS api-build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
# Always build with the sqlite provider. The entrypoint patches schema.prisma
# and re-runs prisma generate at container start when DATABASE_URL points at
# PostgreSQL or MySQL — no separate image variant required.
ARG DATABASE_URL_BUILD="file:/tmp/.build-dummy.db"
ENV DATABASE_URL=${DATABASE_URL_BUILD}
RUN npm ci
COPY apps/api apps/api
WORKDIR /repo/apps/api
RUN npx prisma generate
RUN npm run build

# ── Web build ──────────────────────────────────────────────────────────────────
FROM docker.io/library/node:22-slim AS web-build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
ARG DATABASE_URL_BUILD="file:/tmp/.build-dummy.db"
ENV DATABASE_URL=${DATABASE_URL_BUILD}
RUN npm ci
COPY apps/web apps/web
WORKDIR /repo/apps/web
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM docker.io/library/node:22-slim

# git: git-http + ingest shell out to git. nginx + supervisor: process manager.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl nginx supervisor \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOME=/root
ENV NPM_CONFIG_CACHE=/root/.npm

# ── API ───────────────────────────────────────────────────────────────────────
WORKDIR /app/api
COPY --from=api-build /repo/node_modules /repo/node_modules
COPY --from=api-build /repo/apps/api/dist ./dist
COPY --from=api-build /repo/apps/api/prisma ./prisma
COPY apps/api/package.json ./package.json
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ── Web ───────────────────────────────────────────────────────────────────────
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

# ── Process manager ───────────────────────────────────────────────────────────
COPY docker/supervisord.conf /etc/supervisor/conf.d/forgehub.conf

# ── Data volumes ──────────────────────────────────────────────────────────────
# /data: SQLite DB + bare git repos (durable — do not delete).
# /ci:   CI logs and job workspaces (reconstructible).
RUN mkdir -p /data /data/git-storage /ci

EXPOSE 80

# OCI image metadata — populated by docker/metadata-action in CI.
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="ForgeHub" \
      org.opencontainers.image.description="ForgeHub — collaborative forge for 3D and binary formats (API + Web combined)" \
      org.opencontainers.image.licenses="MIT"

# entrypoint: checks volume writability + applies prisma migrations, then
# execs supervisord which starts nginx and the API.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/forgehub.conf"]
