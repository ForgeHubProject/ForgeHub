/**
 * Archived repositories are read-only (#256): the guard in front of every
 * write under /repos/:handle/:name, and what it lets through.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    repo: { count: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    repoRedirect: { findUnique: vi.fn().mockResolvedValue(null) },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { authHeader, createTestServer } from "./helpers/server.js";

let app: FastifyInstance;
let token: string;
beforeAll(async () => {
  app = await createTestServer();
  token = await authHeader(app, "user-1");
});
afterAll(async () => { await app.close(); });
beforeEach(() => vi.mocked(prisma.repo.count).mockResolvedValue(1 as never));

const send = (method: "POST" | "PATCH" | "PUT" | "DELETE" | "GET", url: string) =>
  app.inject({ method, url, headers: { authorization: token }, payload: method === "GET" ? undefined : {} });

describe("archived repositories", () => {
  it("refuse issues, comments, pull requests and web commits", async () => {
    for (const url of ["/repos/acme/old/issues", "/repos/acme/old/issues/1/comments", "/repos/acme/old/pulls", "/repos/acme/old/contents"]) {
      const res = await send("POST", url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toMatch(/archived/);
    }
  });

  it("still take settings (to unarchive), deletion, stars and watching, and every read", async () => {
    for (const [method, url] of [
      ["PATCH", "/repos/acme/old/settings"], ["DELETE", "/repos/acme/old"], ["PUT", "/repos/acme/old/star"], ["GET", "/repos/acme/old/issues"],
    ] as const) {
      expect((await send(method, url)).statusCode, `${method} ${url}`).not.toBe(403);
    }
  });

  it("let writes through when the repository isn't archived", async () => {
    vi.mocked(prisma.repo.count).mockResolvedValue(0 as never);
    expect((await send("POST", "/repos/acme/old/issues")).statusCode).not.toBe(403);
  });
});
