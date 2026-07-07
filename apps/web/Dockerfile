# Build context is the repo root (needed for npm workspaces):
#   docker build -f apps/web/Dockerfile -t forgehub-web .

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

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
