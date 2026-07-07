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

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
COPY apps/api/package.json ./package.json
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
