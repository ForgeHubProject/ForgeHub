import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    repoTopic: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER_ID = "user-owner";
const WRITER_ID = "user-writer";
const READER_ID = "user-reader";

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    name: "my-repo",
    ownerId: OWNER_ID,
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    collaborators: [
      { userId: WRITER_ID, role: "WRITER" },
      { userId: READER_ID, role: "READER" },
    ],
    ...overrides,
  };
}

let app: FastifyInstance;
beforeAll(async () => { app = await createTestServer(); });
afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
  vi.mocked(prisma.repoTopic.findMany).mockResolvedValue([{ topic: "cad" }, { topic: "gltf" }] as never);
  vi.mocked(prisma.repoTopic.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.repoTopic.createMany).mockResolvedValue({ count: 2 } as never);
  vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
});

describe("GET /repos/:handle/:name/topics", () => {
  it("200 with sorted topics for a public repo (no auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/topics" });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics).toEqual(["cad", "gltf"]);
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/nope/topics" });
    expect(res.statusCode).toBe(404);
  });

  it("404 for a private repo the viewer cannot read", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(
      makeRepo({ visibility: "PRIVATE", collaborators: [] }) as never,
    );
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/topics" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /repos/:handle/:name/topics", () => {
  it("401 without authentication", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      payload: { topics: ["cad"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 and replaces the set for the owner", async () => {
    const token = await authHeader(app, OWNER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: ["cad", "gltf"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics).toEqual(["cad", "gltf"]);
    expect(prisma.repoTopic.deleteMany).toHaveBeenCalledWith({ where: { repoId: "repo-1" } });
    expect(prisma.repoTopic.createMany).toHaveBeenCalledWith({
      data: [
        { repoId: "repo-1", topic: "cad" },
        { repoId: "repo-1", topic: "gltf" },
      ],
    });
  });

  it("200 for a writer collaborator", async () => {
    const token = await authHeader(app, WRITER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: ["cad"] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("403 for a reader collaborator", async () => {
    const token = await authHeader(app, READER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: ["cad"] },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.repoTopic.deleteMany).not.toHaveBeenCalled();
  });

  it("400 for an uppercase / non-kebab topic", async () => {
    const token = await authHeader(app, OWNER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: ["NotKebab"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for a topic with a leading hyphen or doubled hyphen", async () => {
    const token = await authHeader(app, OWNER_ID);
    for (const bad of ["-lead", "double--hyphen", "trail-"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/repos/alice/my-repo/topics",
        headers: { authorization: token },
        payload: { topics: [bad] },
      });
      expect(res.statusCode, `expected 400 for "${bad}"`).toBe(400);
    }
  });

  it("400 when more than 20 topics are submitted", async () => {
    const token = await authHeader(app, OWNER_ID);
    const many = Array.from({ length: 21 }, (_, i) => `topic-${i}`);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: many },
    });
    expect(res.statusCode).toBe(400);
  });

  it("dedupes repeated topics before persisting", async () => {
    const token = await authHeader(app, OWNER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: ["cad", "cad", "gltf"] },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.repoTopic.createMany).toHaveBeenCalledWith({
      data: [
        { repoId: "repo-1", topic: "cad" },
        { repoId: "repo-1", topic: "gltf" },
      ],
    });
  });

  it("accepts an empty set (clears all topics) without calling createMany", async () => {
    const token = await authHeader(app, OWNER_ID);
    vi.mocked(prisma.repoTopic.findMany).mockResolvedValue([] as never);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/my-repo/topics",
      headers: { authorization: token },
      payload: { topics: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics).toEqual([]);
    expect(prisma.repoTopic.createMany).not.toHaveBeenCalled();
  });

  it("404 when repo not found", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const token = await authHeader(app, OWNER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/repos/alice/nope/topics",
      headers: { authorization: token },
      payload: { topics: ["cad"] },
    });
    expect(res.statusCode).toBe(404);
  });
});
