import { buildServer } from "../../server.js";

/** Build a fully-wired test server with a stable JWT secret. */
export async function createTestServer() {
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  const app = await buildServer();
  return app;
}

/** Return an Authorization header value for the given user ID. */
export async function authHeader(app: Awaited<ReturnType<typeof createTestServer>>, userId: string) {
  const token = await app.jwt.sign({ sub: userId });
  return `Bearer ${token}`;
}
