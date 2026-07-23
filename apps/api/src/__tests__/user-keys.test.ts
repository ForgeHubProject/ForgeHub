import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    sSHKey: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    deployKey: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const USER_ID = "user-abc";
const KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINF3319jjgEjhpwtrz3oEC7Q5v9ny/ubnpRxPF3Xt/1F";
const KEY_FP = "SHA256:VCLjt8aUSHPMAP7Q67RG8wteqLWaiuYHoU5DqJUxXd8";

function bothFindUnique(sshRow: unknown, deployRow: unknown = null) {
  vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue(sshRow as never);
  vi.mocked(prisma.deployKey.findUnique).mockResolvedValue(deployRow as never);
}

describe("POST /user/keys", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/user/keys", payload: { title: "laptop", publicKey: KEY_LINE } });
    expect(res.statusCode).toBe(401);
  });

  it("400 for missing title", async () => {
    const res = await app.inject({
      method: "POST", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for an unparseable public key", async () => {
    const res = await app.inject({
      method: "POST", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { title: "laptop", publicKey: "not a real key" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("201 stores the normalized key + fingerprint and returns them", async () => {
    bothFindUnique(null, null); // fingerprint not in use
    vi.mocked(prisma.sSHKey.create).mockImplementation((async ({ data }: any) => ({
      id: "key-1", userId: data.userId, title: data.title, publicKey: data.publicKey,
      fingerprint: data.fingerprint, lastUsedAt: null, createdAt: new Date("2026-01-01"),
    })) as never);

    const res = await app.inject({
      method: "POST", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { title: "laptop", publicKey: `${KEY_LINE} me@host` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.fingerprint).toBe(KEY_FP);
    expect(body.title).toBe("laptop");
    // comment is stripped on store
    expect(body.publicKey).toBe(KEY_LINE);

    const createArg = vi.mocked(prisma.sSHKey.create).mock.calls[0]![0] as any;
    expect(createArg.data.userId).toBe(USER_ID);
    expect(createArg.data.fingerprint).toBe(KEY_FP);
  });

  it("409 when the fingerprint is already registered (dedupe)", async () => {
    bothFindUnique({ id: "existing" }, null);
    const res = await app.inject({
      method: "POST", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { title: "dup", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(409);
    expect(prisma.sSHKey.create).not.toHaveBeenCalled();
  });

  it("409 when the fingerprint is registered as a DEPLOY key (cross-table dedupe)", async () => {
    bothFindUnique(null, { id: "deploy-existing" });
    const res = await app.inject({
      method: "POST", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
      payload: { title: "dup", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(409);
    expect(prisma.sSHKey.create).not.toHaveBeenCalled();
  });
});

describe("GET /user/keys", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  it("lists only the caller's keys with fingerprint + lastUsed", async () => {
    vi.mocked(prisma.sSHKey.findMany).mockResolvedValue([
      { id: "key-1", userId: USER_ID, title: "laptop", publicKey: KEY_LINE, fingerprint: KEY_FP, lastUsedAt: new Date("2026-02-01"), createdAt: new Date("2026-01-01") },
    ] as never);

    const res = await app.inject({
      method: "GET", url: "/user/keys",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].fingerprint).toBe(KEY_FP);
    expect(body.keys[0].lastUsedAt).toBeTruthy();
    const where = vi.mocked(prisma.sSHKey.findMany).mock.calls[0]![0] as any;
    expect(where.where.userId).toBe(USER_ID);
  });
});

describe("DELETE /user/keys/:id", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("204 and deletes when the caller owns the key", async () => {
    vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue({ id: "key-1", userId: USER_ID } as never);
    const res = await app.inject({
      method: "DELETE", url: "/user/keys/key-1",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.sSHKey.delete).toHaveBeenCalledWith({ where: { id: "key-1" } });
  });

  it("404 when the key belongs to another user", async () => {
    vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue({ id: "key-1", userId: "someone-else" } as never);
    const res = await app.inject({
      method: "DELETE", url: "/user/keys/key-1",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.sSHKey.delete).not.toHaveBeenCalled();
  });

  it("404 when the key does not exist", async () => {
    vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "DELETE", url: "/user/keys/nope",
      headers: { authorization: await authHeader(app, USER_ID) },
    });
    expect(res.statusCode).toBe(404);
  });
});
