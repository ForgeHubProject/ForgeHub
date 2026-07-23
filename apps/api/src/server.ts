import "./handlers/index.js";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { branchRoutes } from "./routes/branches.js";
import { codeNavRoutes } from "./routes/code-nav.js";
import { commitRoutes } from "./routes/commits.js";
import { compareRoutes } from "./routes/compare.js";
import { fhrRoutes } from "./routes/fhr.js";
import { fileDiffRoutes } from "./routes/filediff.js";
import { rendererRoutes } from "./routes/renderers.js";
import { constraintRoutes } from "./routes/constraints.js";
import { devUiRoutes } from "./routes/dev-ui.js";
import { entityRoutes } from "./routes/entities.js";
import { forkRoutes } from "./routes/forks.js";
import { gitHttpRoutes } from "./routes/git-http.js";
import { issueRoutes } from "./routes/issues.js";
import { labelRoutes } from "./routes/labels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { prCommentRoutes } from "./routes/pr-comments.js";
import { pullRoutes } from "./routes/pulls.js";
import { releaseRoutes } from "./routes/releases.js";
import { repoRoutes } from "./routes/repos.js";
import { searchRoutes } from "./routes/search.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { topicRoutes } from "./routes/topics.js";
import { compositionRoutes } from "./routes/composition.js";
import { tagRoutes } from "./routes/tags.js";
import { tokenRoutes } from "./routes/tokens.js";
import { timelineRoutes } from "./routes/timeline.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { resolvePatBearer } from "./pat-auth.js";
import { hasScope, type PatScope } from "./scopes.js";

export async function buildServer() {
  const secret = process.env["JWT_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET must be set to a string at least 16 characters long");
  }

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret });

  // Release-asset uploads. Truncate (don't throw) at the size cap so the route
  // can detect an over-limit file via `part.file.truncated` and return 413.
  const maxAssetBytes = Number(process.env["RELEASE_ASSET_MAX_BYTES"] ?? 100 * 1024 * 1024);
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxAssetBytes, files: 1 },
  });

  // Every request starts unscoped; the PAT paths below stamp the token's scopes.
  // null ⇒ session/JWT (or guest) ⇒ full power, so `requireScope` is a no-op.
  app.decorateRequest("patScopes", null);

  app.decorate(
    "authenticate",
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
        return; // session/JWT — unscoped, full access
      } catch {
        // Not a valid session JWT — fall through to Personal Access Token auth.
      }
      const pat = await resolvePatBearer(request);
      if (pat) {
        request.user = { sub: pat.userId };
        request.patScopes = pat.scopes;
        return;
      }
      return reply.status(401).send({ error: "Unauthorized" });
    },
  );

  app.decorate(
    "optionalAuthenticate",
    async function optionalAuthenticate(request: FastifyRequest) {
      try {
        await request.jwtVerify();
        return;
      } catch {
        // Not a session JWT — try a PAT, else treat as guest.
      }
      const pat = await resolvePatBearer(request);
      if (pat) {
        request.user = { sub: pat.userId };
        request.patScopes = pat.scopes;
      }
      // guest — private routes must use `authenticate` instead
    },
  );

  // PreHandler factory. A session/JWT (patScopes null) always passes; a PAT must
  // carry the required scope (issue #87). Consulted by write-gated (repo:write)
  // and settings/token (admin) routes.
  app.decorate("requireScope", function requireScope(scope: PatScope) {
    return async function scopeGuard(request: FastifyRequest, reply: FastifyReply) {
      const scopes = request.patScopes;
      if (scopes === null || scopes === undefined) return; // session — full access
      if (!hasScope(scopes, scope)) {
        return reply.status(403).send({ error: `Token is missing the '${scope}' scope` });
      }
    };
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(devUiRoutes);
  await app.register(authRoutes);
  await app.register(tokenRoutes);
  await app.register(repoRoutes);
  await app.register(snapshotRoutes);
  await app.register(compareRoutes);
  await app.register(fhrRoutes);
  await app.register(fileDiffRoutes);
  await app.register(rendererRoutes);
  await app.register(constraintRoutes);
  await app.register(entityRoutes);
  await app.register(branchRoutes);
  await app.register(commitRoutes);
  await app.register(codeNavRoutes);
  await app.register(tagRoutes);
  await app.register(forkRoutes);
  await app.register(pullRoutes);
  await app.register(releaseRoutes);
  await app.register(prCommentRoutes);
  await app.register(issueRoutes);
  await app.register(labelRoutes);
  await app.register(notificationRoutes);
  await app.register(timelineRoutes);
  await app.register(searchRoutes);
  await app.register(topicRoutes);
  await app.register(compositionRoutes);
  await app.register(webhookRoutes);
  await app.register(gitHttpRoutes);

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env["PORT"] ?? 3001);
  buildServer()
    .then((app) =>
      app.listen({ port, host: "0.0.0.0" }).then(() => {
        app.log.info(`Listening on http://localhost:${port}`);
      }),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
