# Build context is the repo root (needed for npm workspaces):
#   docker build -f apps/web/Dockerfile -t forgehub-web .
#   podman build -f apps/web/Dockerfile -t forgehub-web .

FROM node:22-slim AS build
# openssl: npm ci runs every workspace's "prepare" script, including api's `prisma generate`.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci
COPY apps/web apps/web
WORKDIR /repo/apps/web
# Empty VITE_API_URL = same-origin; nginx.conf below proxies API paths to the api container.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM docker.io/library/nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# OCI image metadata — populated by docker/metadata-action in CI.
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="ForgeHub Web" \
      org.opencontainers.image.description="ForgeHub web frontend — React 19 SPA served via nginx" \
      org.opencontainers.image.licenses="MIT"
