import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { gitHttpRoutes } from "./routes/git-http.js";
import { repoRoutes } from "./routes/repos.js";

async function buildServer() {
  const secret = process.env["JWT_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET must be set to a string at least 16 characters long");
  }

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret });

  app.decorate(
    "authenticate",
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    },
  );

  app.decorate(
    "optionalAuthenticate",
    async function optionalAuthenticate(request: FastifyRequest) {
      try {
        await request.jwtVerify();
      } catch {
        // guest — private routes must use `authenticate` instead
      }
    },
  );

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(repoRoutes);
  await app.register(gitHttpRoutes);

  return app;
}

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
